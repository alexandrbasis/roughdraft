import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  ReviewEventQueue,
  type ReviewCompletedEvent,
  type ReviewCompletedEventInput,
} from "./review-events.js";
import { ReviewRegistry, type ReviewRecord } from "./review-registry.js";

const require = createRequire(import.meta.url);
const canonical = (file: string) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};
const hash = (content: string) =>
  createHash("sha256").update(content).digest("hex");
const decode = <T>(row: unknown): T =>
  JSON.parse((row as { payload: string }).payload) as T;

export class ReviewDatabaseError extends Error {
  constructor(
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}

export interface ServerDraft {
  storageKey: string;
  content: string;
  baseContent: string;
  baseVersion: string | null;
  revision: string;
  tabId: string;
  updatedAt: number;
}
export interface ReviewRound {
  id: string;
  documentPath: string;
  openedAt: string;
  openedVersion?: string;
  completedAt?: string;
  completedVersion?: string;
  eventSequence?: number;
  status: "pending" | "completed";
}
export interface DocumentRevision {
  id: string;
  number: number;
  content: string;
  version: string;
  source: "baseline" | "external" | "review";
  createdAt: string;
}

export interface CompletedIteration extends DocumentRevision {
  actor: "agent" | "user" | "unknown";
  author?: string;
  completedAt: string | null;
}

export type DocumentEditingState = "editing" | "awaiting-review" | "completed";

interface IterationState {
  editingState: DocumentEditingState;
  startedAt?: string;
}

interface PendingWrite {
  id: string;
  documentPath: string;
  before: string;
  after: string;
  actor?: "agent";
  completion?: ReviewCompletedEventInput;
  roundId?: string;
  repeatCompletion?: boolean;
  createdAt: string;
}

/** Single local daemon owns writes; CLI readers use a read-only connection. */
export class ReviewDatabase {
  readonly filePath: string | null;
  private db: DatabaseSync;

  constructor(stateDirectory?: string) {
    this.filePath = stateDirectory
      ? path.join(path.resolve(stateDirectory), "roughdraft.sqlite")
      : null;
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), {
        recursive: true,
        mode: 0o700,
      });
      const fd = fs.openSync(this.filePath, "a", 0o600);
      fs.closeSync(fd);
      fs.chmodSync(this.filePath, 0o600);
    }
    const { DatabaseSync: SQLite } =
      require("node:sqlite") as typeof import("node:sqlite");
    this.db = new SQLite(this.filePath ?? ":memory:");
    try {
      this.db.exec(
        "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
      );
      const version = this.db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      if (version.user_version > 2)
        throw new ReviewDatabaseError(
          "Roughdraft database was created by a newer version.",
        );
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS documents (document_path TEXT PRIMARY KEY, route TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS rounds (id TEXT PRIMARY KEY, document_path TEXT NOT NULL, opened_at TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS rounds_document ON rounds(document_path, opened_at);
        CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY, document_path TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_document ON events(document_path, sequence);
        CREATE TABLE IF NOT EXISTS acknowledgements (sequence INTEGER NOT NULL REFERENCES events(sequence), consumer_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('received','processed')), updated_at TEXT NOT NULL, PRIMARY KEY(sequence, consumer_id));
        CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, document_path TEXT NOT NULL, version TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, reason TEXT NOT NULL, UNIQUE(document_path, version));
        CREATE TABLE IF NOT EXISTS document_revisions (id TEXT PRIMARY KEY, document_path TEXT NOT NULL, number INTEGER NOT NULL, content TEXT NOT NULL, version TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('baseline','external','review')), created_at TEXT NOT NULL, UNIQUE(document_path, number));
        CREATE TABLE IF NOT EXISTS document_iterations (id TEXT PRIMARY KEY, document_path TEXT NOT NULL, number INTEGER NOT NULL, content TEXT NOT NULL, version TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('baseline','external','review')), actor TEXT NOT NULL CHECK(actor IN ('agent','user','unknown')), author TEXT, created_at TEXT NOT NULL, completed_at TEXT, UNIQUE(document_path, number));
        CREATE TABLE IF NOT EXISTS document_iteration_state (document_path TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS file_writes (id TEXT PRIMARY KEY, document_path TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS drafts (document_path TEXT NOT NULL, tab_id TEXT NOT NULL, revision TEXT NOT NULL, updated_at REAL NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL, PRIMARY KEY(document_path, tab_id));
        COMMIT;
      `);
      this.importLegacy(stateDirectory);
      this.transaction(() => {
        if (version.user_version === 1) this.seedLegacyIterations();
        this.db.exec("PRAGMA user_version=2");
      });
      this.recoverWrites();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private iterationState(documentPath: string): IterationState | null {
    const row = this.db
      .prepare(
        "SELECT payload FROM document_iteration_state WHERE document_path=?",
      )
      .get(documentPath);
    return row ? decode<IterationState>(row) : null;
  }

  private setIterationState(
    documentPath: string,
    editingState: DocumentEditingState,
  ): void {
    const previous = this.iterationState(documentPath);
    const state: IterationState = {
      editingState,
      ...(editingState === "editing"
        ? { startedAt: previous?.startedAt ?? new Date().toISOString() }
        : {}),
    };
    this.db
      .prepare(
        "INSERT INTO document_iteration_state VALUES(?,?) ON CONFLICT(document_path) DO UPDATE SET payload=excluded.payload",
      )
      .run(documentPath, JSON.stringify(state));
  }

  private latestIteration(
    documentPath: string,
  ): CompletedIteration | undefined {
    return this.db
      .prepare(
        "SELECT id,number,content,version,source,actor,author,created_at AS createdAt,completed_at AS completedAt FROM document_iterations WHERE document_path=? ORDER BY number DESC LIMIT 1",
      )
      .get(documentPath) as unknown as CompletedIteration | undefined;
  }

  private completeIteration(
    documentPath: string,
    content: string,
    actor: CompletedIteration["actor"],
    author?: string,
    force = false,
    observedAt?: string,
  ): CompletedIteration {
    const latest = this.latestIteration(documentPath);
    if (
      actor === "agent" &&
      latest?.actor === "unknown" &&
      latest.completedAt === null &&
      latest.content === content
    ) {
      const completedAt = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE document_iterations SET actor='agent',author=?,completed_at=? WHERE id=?",
        )
        .run(author ?? "Agent", completedAt, latest.id);
      this.log("iteration-promoted", {
        number: latest.number,
        version: latest.version,
      });
      return {
        ...latest,
        actor: "agent",
        author: author ?? "Agent",
        completedAt,
      };
    }
    if (!force && latest?.content === content) return latest;
    const createdAt = observedAt ?? new Date().toISOString();
    const completedAt = actor === "unknown" ? null : new Date().toISOString();
    const iteration: CompletedIteration = {
      id: randomUUID(),
      number: (latest?.number ?? 0) + 1,
      content,
      version: hash(content),
      source: !latest ? "baseline" : actor === "user" ? "review" : "external",
      actor,
      ...(author ? { author } : {}),
      createdAt,
      completedAt,
    };
    this.db
      .prepare("INSERT INTO document_iterations VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        iteration.id,
        documentPath,
        iteration.number,
        iteration.content,
        iteration.version,
        iteration.source,
        iteration.actor,
        author ?? null,
        iteration.createdAt,
        iteration.completedAt,
      );
    this.log("iteration-completed", {
      number: iteration.number,
      actor,
      version: iteration.version,
    });
    return iteration;
  }

  private seedLegacyIterations(): void {
    const rows = this.db
      .prepare(
        "SELECT document_path AS documentPath FROM document_revisions UNION SELECT document_path AS documentPath FROM documents",
      )
      .all() as { documentPath: string }[];
    for (const { documentPath } of rows) {
      const checkpoints = this.db
        .prepare(
          "SELECT content,created_at AS createdAt FROM document_revisions WHERE document_path=? ORDER BY number",
        )
        .all(documentPath) as { content: string; createdAt: string }[];
      for (const checkpoint of checkpoints)
        this.snapshot(
          documentPath,
          checkpoint.content,
          "observed-revision",
          checkpoint.createdAt,
        );
      if (this.latestIteration(documentPath)) continue;
      const latest = checkpoints.at(-1);
      let content = latest?.content;
      if (content === undefined) {
        try {
          content = fs.readFileSync(documentPath, "utf8");
        } catch {
          // Missing legacy documents remain in their original registry state.
        }
      }
      if (content !== undefined)
        this.completeIteration(
          documentPath,
          content,
          "unknown",
          "Original",
          false,
          latest?.createdAt,
        );
    }
  }

  private importLegacy(stateDirectory?: string): void {
    if (
      this.db
        .prepare("SELECT value FROM metadata WHERE key='legacy-imported'")
        .get()
    )
      return;
    // Validate both original stores before opening the import transaction. Keep
    // them byte-for-byte as migration backups; never import them a second time.
    const records = stateDirectory
      ? new ReviewRegistry({ stateDir: stateDirectory }).list()
      : [];
    const legacyQueue = new ReviewEventQueue(
      stateDirectory
        ? path.join(stateDirectory, "review-events.json")
        : undefined,
    );
    const events = legacyQueue.snapshot();
    this.transaction(() => {
      if (
        this.db
          .prepare("SELECT value FROM metadata WHERE key='legacy-imported'")
          .get()
      )
        return;
      for (const record of records) {
        const latest = events
          .filter(
            (event) => canonical(event.documentPath) === record.documentPath,
          )
          .at(-1);
        if (
          record.status === "pending" &&
          latest &&
          (record.openedAfterSequence !== undefined
            ? latest.sequence > record.openedAfterSequence
            : latest.createdAt > record.openedAt)
        ) {
          record.status = "completed";
          record.completedAt = latest.createdAt;
          record.completionEvent = latest;
        }
        this.upsertRecord(record);
        const completion = record.completionEvent as
          | ReviewCompletedEvent
          | undefined;
        this.insertRound({
          id: randomUUID(),
          documentPath: record.documentPath,
          openedAt: record.openedAt,
          status: record.status,
          completedAt: record.completedAt,
          eventSequence: completion?.sequence,
          completedVersion: completion?.version,
        });
      }
      for (const event of events)
        this.db
          .prepare("INSERT INTO events VALUES(?,?,?)")
          .run(
            event.sequence,
            canonical(event.documentPath),
            JSON.stringify(event),
          );
      this.db
        .prepare("INSERT INTO metadata VALUES('next-sequence',?)")
        .run(String(legacyQueue.latestSequence() + 1));
      this.db
        .prepare("INSERT INTO metadata VALUES('legacy-imported',?)")
        .run(new Date().toISOString());
    });
    this.log("migration", { records: records.length, events: events.length });
  }

  listRecords(): ReviewRecord[] {
    return this.db
      .prepare("SELECT payload FROM documents ORDER BY rowid")
      .all()
      .map((row) => decode<ReviewRecord>(row));
  }

  private upsertRecord(record: ReviewRecord): void {
    this.db
      .prepare(
        "INSERT INTO documents VALUES(?,?,?) ON CONFLICT(document_path) DO UPDATE SET route=excluded.route,payload=excluded.payload",
      )
      .run(record.documentPath, record.route, JSON.stringify(record));
  }

  saveRecord(record: ReviewRecord, opening: boolean): void {
    this.transaction(() => {
      this.upsertRecord(record);
      if (opening) {
        const content = fs.readFileSync(record.documentPath, "utf8");
        // Keep the established opened-snapshot label when this is also the
        // first observed file version. The checkpoint insert deduplicates it.
        this.snapshot(record.documentPath, content, "opened");
        const checkpoint = this.recordRevision(
          record.documentPath,
          content,
          "external",
        );
        // Opening hands the current agent edition to the human. A pending
        // human edit belongs to that review, even if the file has autosaved.
        const previous = this.latestIteration(record.documentPath);
        const wasEditing =
          this.iterationState(record.documentPath)?.editingState === "editing";
        const externalEdition =
          checkpoint.source === "external" && previous?.content !== content;
        const provisionalHandoff =
          previous?.actor === "unknown" &&
          previous.completedAt === null &&
          previous.content === content;
        if (!wasEditing || externalEdition || provisionalHandoff) {
          this.completeIteration(
            record.documentPath,
            content,
            "agent",
            "Agent",
          );
          this.setIterationState(record.documentPath, "awaiting-review");
        }
        // Multiple agents opening a still-pending document join the same round.
        const pending = this.currentRound(record.documentPath);
        if (!pending || pending.status === "completed") {
          this.insertRound({
            id: randomUUID(),
            documentPath: record.documentPath,
            openedAt: record.openedAt,
            openedVersion: hash(content),
            status: "pending",
          });
        }
      }
    });
  }

  private insertRound(round: ReviewRound): void {
    this.db
      .prepare(
        "INSERT INTO rounds VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload",
      )
      .run(
        round.id,
        round.documentPath,
        round.openedAt,
        round.status,
        JSON.stringify(round),
      );
  }

  private currentRound(documentPath: string): ReviewRound | null {
    const row = this.db
      .prepare(
        "SELECT payload FROM rounds WHERE document_path=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(documentPath);
    return row ? decode<ReviewRound>(row) : null;
  }

  loadEvents(): { events: ReviewCompletedEvent[]; nextSequence: number } {
    const events = this.db
      .prepare("SELECT payload FROM events ORDER BY sequence")
      .all()
      .map((row) => decode<ReviewCompletedEvent>(row));
    const cursor = this.db
      .prepare("SELECT value FROM metadata WHERE key='next-sequence'")
      .get() as { value: string } | undefined;
    return {
      events,
      nextSequence: Math.max(
        Number(cursor?.value ?? 1),
        (events.at(-1)?.sequence ?? 0) + 1,
      ),
    };
  }

  appendEvent(event: ReviewCompletedEvent, writeId?: string): void {
    this.transaction(() => {
      const writeRow = writeId
        ? this.db
            .prepare("SELECT payload FROM file_writes WHERE id=?")
            .get(writeId)
        : undefined;
      const write = writeRow ? decode<PendingWrite>(writeRow) : undefined;
      const roundRow = write?.roundId
        ? this.db
            .prepare("SELECT payload FROM rounds WHERE id=?")
            .get(write.roundId)
        : undefined;
      const round = write?.roundId
        ? roundRow
          ? decode<ReviewRound>(roundRow)
          : null
        : this.currentRound(canonical(event.documentPath));
      if (
        write?.roundId &&
        round?.status === "completed" &&
        !write.repeatCompletion
      )
        throw new ReviewDatabaseError(
          "This review round is already completed.",
        );
      if (round) event.roundId = round.id;
      this.db
        .prepare("INSERT INTO events VALUES(?,?,?)")
        .run(
          event.sequence,
          canonical(event.documentPath),
          JSON.stringify(event),
        );
      this.db
        .prepare(
          "INSERT INTO metadata VALUES('next-sequence',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(String(event.sequence + 1));
      const row = this.db
        .prepare("SELECT payload FROM documents WHERE document_path=?")
        .get(canonical(event.documentPath));
      if (row) {
        const record = decode<ReviewRecord>(row);
        this.upsertRecord({
          ...record,
          status: "completed",
          completedAt: event.createdAt,
          completionEvent: event,
        });
      }
      if (round && !write?.repeatCompletion)
        this.insertRound({
          ...round,
          status: "completed",
          completedAt: event.createdAt,
          completedVersion: event.version,
          eventSequence: event.sequence,
        });
      if (writeId) this.finishWriteInternal(writeId);
      if (!write?.repeatCompletion)
        this.completeIteration(
          canonical(event.documentPath),
          fs.readFileSync(event.documentPath, "utf8"),
          "user",
          "User",
          true,
        );
      this.setIterationState(canonical(event.documentPath), "completed");
      if (round && !write?.repeatCompletion)
        this.db
          .prepare(
            "UPDATE file_writes SET status='superseded' WHERE status='pending' AND json_extract(payload,'$.roundId')=? AND json_extract(payload,'$.completion') IS NOT NULL",
          )
          .run(round.id);
    });
    this.log("completion", {
      sequence: event.sequence,
      roundId: event.roundId,
    });
  }

  acknowledge(
    sequence: number,
    consumerId: string,
    status: "received" | "processed",
  ) {
    if (
      !Number.isSafeInteger(sequence) ||
      sequence <= 0 ||
      !consumerId.trim() ||
      consumerId.length > 200 ||
      !["received", "processed"].includes(status)
    )
      throw new ReviewDatabaseError(
        "Valid sequence, consumerId and acknowledgement status are required.",
        400,
      );
    if (!this.db.prepare("SELECT 1 FROM events WHERE sequence=?").get(sequence))
      throw new ReviewDatabaseError("Review event not found.", 404);
    this.db
      .prepare(
        `INSERT INTO acknowledgements VALUES(?,?,?,?) ON CONFLICT(sequence,consumer_id) DO UPDATE SET status=CASE WHEN acknowledgements.status='processed' THEN 'processed' ELSE excluded.status END, updated_at=CASE WHEN acknowledgements.status='processed' THEN acknowledgements.updated_at ELSE excluded.updated_at END`,
      )
      .run(sequence, consumerId, status, new Date().toISOString());
    this.log("acknowledgement", { sequence, consumerId, status });
    return this.db
      .prepare(
        "SELECT sequence,consumer_id AS consumerId,status,updated_at AS updatedAt FROM acknowledgements WHERE sequence=? AND consumer_id=?",
      )
      .get(sequence, consumerId);
  }

  private snapshot(
    documentPath: string,
    content: string,
    reason: string,
    createdAt = new Date().toISOString(),
  ): void {
    this.db
      .prepare("INSERT OR IGNORE INTO snapshots VALUES(?,?,?,?,?,?)")
      .run(
        randomUUID(),
        documentPath,
        hash(content),
        content,
        createdAt,
        reason,
      );
  }

  prepareWrite(
    documentPath: string,
    content: string,
    completion?: ReviewCompletedEventInput,
    actor?: "agent",
  ): string {
    documentPath = canonical(documentPath);
    const before = fs.readFileSync(documentPath, "utf8");
    const write: PendingWrite = {
      id: randomUUID(),
      documentPath,
      before,
      after: content,
      ...(actor ? { actor } : {}),
      completion,
      createdAt: new Date().toISOString(),
    };
    this.transaction(() => {
      if (completion && !this.latestIteration(documentPath))
        this.completeIteration(documentPath, before, "unknown", "Original");
      if (completion) {
        let round = this.currentRound(documentPath);
        if (
          round?.status === "completed" &&
          content === before &&
          this.latestIteration(documentPath)?.content === before
        ) {
          write.repeatCompletion = true;
        } else if (!round || round.status === "completed") {
          round = {
            id: randomUUID(),
            documentPath,
            openedAt: write.createdAt,
            openedVersion: hash(before),
            status: "pending",
          };
          this.insertRound(round);
        }
        write.roundId = round.id;
      }
      this.snapshot(documentPath, before, "before-save");
      this.recordRevision(documentPath, before, "external");
      this.snapshot(documentPath, content, "proposed-save");
      this.db
        .prepare("INSERT INTO file_writes VALUES(?,?,'pending',?)")
        .run(write.id, documentPath, JSON.stringify(write));
    });
    return write.id;
  }

  finishWrite(id: string): void {
    this.transaction(() => this.finishWriteInternal(id));
  }
  cancelWrite(id: string): void {
    this.db
      .prepare(
        "UPDATE file_writes SET status='conflict' WHERE id=? AND status='pending'",
      )
      .run(id);
  }
  private finishWriteInternal(id: string): void {
    const row = this.db
      .prepare(
        "SELECT payload FROM file_writes WHERE id=? AND status='pending'",
      )
      .get(id);
    if (!row) return;
    const write = decode<PendingWrite>(row);
    // Only confirmed bytes become revisions. Recovery uses this same path.
    if (fs.readFileSync(write.documentPath, "utf8") !== write.after)
      throw new ReviewDatabaseError(
        "The file changed before the save was recorded.",
      );
    if (!write.completion && !this.latestIteration(write.documentPath))
      this.completeIteration(
        write.documentPath,
        write.before,
        "unknown",
        "Original",
      );
    this.recordRevision(
      write.documentPath,
      write.after,
      write.actor === "agent" ? "external" : "review",
    );
    if (write.actor === "agent") {
      this.completeIteration(write.documentPath, write.after, "agent", "Agent");
      this.setIterationState(write.documentPath, "awaiting-review");
    } else if (!write.completion) {
      this.setIterationState(write.documentPath, "editing");
    }
    this.db
      .prepare(
        "UPDATE file_writes SET status='applied' WHERE id=? AND status='pending'",
      )
      .run(id);
  }

  private recoverWrites(): void {
    const rows = this.db
      .prepare(
        "SELECT payload FROM file_writes WHERE status='pending' ORDER BY rowid",
      )
      .all();
    for (const row of rows) {
      const write = decode<PendingWrite>(row);
      const roundRow = write.roundId
        ? this.db
            .prepare("SELECT payload FROM rounds WHERE id=?")
            .get(write.roundId)
        : undefined;
      if (
        write.completion &&
        roundRow &&
        decode<ReviewRound>(roundRow).status === "completed"
      ) {
        this.db
          .prepare("UPDATE file_writes SET status='superseded' WHERE id=?")
          .run(write.id);
        continue;
      }
      let current: string | null = null;
      try {
        current = fs.readFileSync(write.documentPath, "utf8");
      } catch {
        /* Missing files remain recoverable snapshots. */
      }
      if (current === write.after) {
        if (write.completion)
          this.appendEvent(
            {
              ...write.completion,
              type: "review.completed",
              version: hash(current),
              sequence: this.loadEvents().nextSequence,
              createdAt: new Date().toISOString(),
            },
            write.id,
          );
        else this.finishWrite(write.id);
      } else {
        this.db
          .prepare("UPDATE file_writes SET status=? WHERE id=?")
          .run(current === write.before ? "aborted" : "conflict", write.id);
      }
      this.log("write-recovered", {
        id: write.id,
        matched: current === write.after,
      });
    }
  }

  /** Observe real local bytes; proposals and drafts never enter this ledger. */
  observeRevision(documentPath: string, content: string): DocumentRevision {
    return this.transaction(() =>
      this.recordRevision(canonical(documentPath), content, "external"),
    );
  }

  private recordRevision(
    documentPath: string,
    content: string,
    source: "external" | "review",
  ): DocumentRevision {
    const latest = this.db
      .prepare(
        "SELECT id,number,content,version,source,created_at AS createdAt FROM document_revisions WHERE document_path=? ORDER BY number DESC LIMIT 1",
      )
      .get(documentPath) as unknown as DocumentRevision | undefined;
    if (latest?.content === content) return latest;
    const revision: DocumentRevision = {
      id: randomUUID(),
      number: latest ? latest.number + 1 : 0,
      content,
      version: hash(content),
      source: latest ? source : "baseline",
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO document_revisions VALUES(?,?,?,?,?,?,?)")
      .run(
        revision.id,
        documentPath,
        revision.number,
        content,
        revision.version,
        revision.source,
        revision.createdAt,
      );
    this.snapshot(
      documentPath,
      content,
      "observed-revision",
      revision.createdAt,
    );
    this.log("revision-recorded", {
      number: revision.number,
      version: revision.version,
      source: revision.source,
    });
    return revision;
  }

  revisions(documentPath: string): DocumentRevision[] {
    return this.db
      .prepare(
        "SELECT id,number,content,version,source,created_at AS createdAt FROM document_revisions WHERE document_path=? ORDER BY number",
      )
      .all(canonical(documentPath)) as unknown as DocumentRevision[];
  }

  completedIterations(documentPath: string): CompletedIteration[] {
    documentPath = canonical(documentPath);
    // Direct-path browser reviews have no handoff call. The first request
    // presents the current bytes as an original edition without assigning an
    // author to earlier checkpoints.
    if (!this.latestIteration(documentPath) && fs.existsSync(documentPath)) {
      this.transaction(() => {
        if (!this.latestIteration(documentPath))
          this.completeIteration(
            documentPath,
            fs.readFileSync(documentPath, "utf8"),
            "unknown",
            "Original",
          );
      });
    }
    return this.db
      .prepare(
        "SELECT id,number,content,version,source,actor,author,created_at AS createdAt,completed_at AS completedAt FROM document_iterations WHERE document_path=? ORDER BY number",
      )
      .all(documentPath) as unknown as CompletedIteration[];
  }

  documentEditingState(documentPath: string): DocumentEditingState {
    documentPath = canonical(documentPath);
    const explicit = this.iterationState(documentPath);
    if (explicit) return explicit.editingState;
    const record = this.db
      .prepare("SELECT payload FROM documents WHERE document_path=?")
      .get(documentPath);
    return record && decode<ReviewRecord>(record).status === "completed"
      ? "completed"
      : "awaiting-review";
  }

  completeUnchangedAgentSubmission(
    documentPath: string,
    content: string,
  ): void {
    documentPath = canonical(documentPath);
    this.transaction(() => {
      this.completeIteration(documentPath, content, "agent", "Agent", true);
      this.setIterationState(documentPath, "awaiting-review");
    });
  }

  pendingAgentHandoffPaths(): string[] {
    const records = new Map(
      this.listRecords().map((record) => [record.documentPath, record]),
    );
    const paths = this.db
      .prepare(
        "SELECT document_path AS documentPath FROM document_iteration_state",
      )
      .all() as { documentPath: string }[];
    return paths
      .map(({ documentPath }) => documentPath)
      .filter((documentPath) => {
        if (!fs.existsSync(documentPath)) return false;
        const latest = this.latestIteration(documentPath);
        return (
          latest?.actor === "agent" &&
          latest.content === fs.readFileSync(documentPath, "utf8") &&
          this.documentEditingState(documentPath) === "awaiting-review" &&
          records.get(documentPath)?.status !== "pending"
        );
      });
  }

  currentIteration(documentPath: string, content: string) {
    documentPath = canonical(documentPath);
    if (this.documentEditingState(documentPath) !== "editing") return null;
    return {
      number: (this.latestIteration(documentPath)?.number ?? 0) + 1,
      actor: "user" as const,
      content,
      version: hash(content),
      startedAt:
        this.iterationState(documentPath)?.startedAt ??
        new Date().toISOString(),
    };
  }

  recoveryPoints(documentPath: string) {
    return this.db
      .prepare(
        "SELECT id,document_path AS documentPath,content,version,created_at AS createdAt,reason FROM snapshots WHERE document_path=? ORDER BY rowid DESC",
      )
      .all(canonical(documentPath));
  }

  history(documentPath: string) {
    documentPath = canonical(documentPath);
    return {
      rounds: this.db
        .prepare(
          "SELECT payload FROM rounds WHERE document_path=? ORDER BY rowid DESC",
        )
        .all(documentPath)
        .map((row) => decode<ReviewRound>(row)),
      snapshots: this.recoveryPoints(documentPath),
      acknowledgements: this.db
        .prepare(
          "SELECT a.sequence,a.consumer_id AS consumerId,a.status,a.updated_at AS updatedAt FROM acknowledgements a JOIN events e ON e.sequence=a.sequence WHERE e.document_path=? ORDER BY a.sequence DESC",
        )
        .all(documentPath),
      writes: this.db
        .prepare(
          "SELECT id,status FROM file_writes WHERE document_path=? AND status IN ('pending','conflict') ORDER BY rowid DESC",
        )
        .all(documentPath),
    };
  }

  getSnapshot(id: string, documentPath: string) {
    documentPath = canonical(documentPath);
    return this.db
      .prepare(
        "SELECT id,document_path AS documentPath,content,version,created_at AS createdAt,reason FROM snapshots WHERE id=? AND document_path=?",
      )
      .get(id, documentPath);
  }

  listDrafts(documentPath: string) {
    documentPath = canonical(documentPath);
    return this.db
      .prepare(
        "SELECT payload FROM drafts WHERE document_path=? AND deleted=0 ORDER BY updated_at DESC",
      )
      .all(documentPath)
      .map((row) => ({ ...decode<ServerDraft>(row), documentPath }));
  }

  saveDraft(documentPath: string, draft: ServerDraft) {
    documentPath = canonical(documentPath);
    if (
      !draft ||
      [
        draft.storageKey,
        draft.content,
        draft.baseContent,
        draft.revision,
        draft.tabId,
      ].some((value) => typeof value !== "string") ||
      !draft.revision ||
      !draft.tabId ||
      (draft.baseVersion !== null && typeof draft.baseVersion !== "string") ||
      !Number.isFinite(draft.updatedAt) ||
      draft.updatedAt < 0 ||
      draft.content.length + draft.baseContent.length > 8_000_000 ||
      draft.tabId.length > 200 ||
      draft.revision.length > 200
    )
      throw new ReviewDatabaseError("Invalid server draft.", 400);
    return this.transaction(() => {
      const latest = this.latestIteration(documentPath);
      const staleAfterCompletion =
        this.documentEditingState(documentPath) === "completed" &&
        latest?.completedAt !== null &&
        latest?.completedAt !== undefined &&
        draft.updatedAt < Date.parse(latest.completedAt);
      if (staleAfterCompletion) {
        this.snapshot(documentPath, draft.content, "browser-draft");
        return { ...draft, documentPath };
      }
      const previous = this.db
        .prepare(
          "SELECT revision,updated_at,deleted FROM drafts WHERE document_path=? AND tab_id=?",
        )
        .get(documentPath, draft.tabId) as
        | { revision: string; updated_at: number; deleted: number }
        | undefined;
      if (
        previous &&
        (previous.updated_at > draft.updatedAt ||
          (previous.updated_at === draft.updatedAt &&
            (previous.revision !== draft.revision || previous.deleted)))
      )
        throw new ReviewDatabaseError("A newer draft revision already exists.");
      if (!this.latestIteration(documentPath))
        this.completeIteration(
          documentPath,
          fs.readFileSync(documentPath, "utf8"),
          "unknown",
          "Original",
        );
      this.db
        .prepare(
          "INSERT INTO drafts VALUES(?,?,?,?,0,?) ON CONFLICT(document_path,tab_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,deleted=0,payload=excluded.payload",
        )
        .run(
          documentPath,
          draft.tabId,
          draft.revision,
          draft.updatedAt,
          JSON.stringify(draft),
        );
      if (
        this.documentEditingState(documentPath) !== "completed" ||
        this.latestIteration(documentPath)?.content !== draft.content
      )
        this.setIterationState(documentPath, "editing");
      return { ...draft, documentPath };
    });
  }

  deleteDraft(documentPath: string, tabId: string, revision: string): boolean {
    documentPath = canonical(documentPath);
    // Retain the revision tombstone so a delayed retry cannot resurrect it.
    return this.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT payload FROM drafts WHERE document_path=? AND tab_id=? AND revision=? AND deleted=0",
        )
        .get(documentPath, tabId, revision);
      if (!row) return false;
      this.snapshot(
        documentPath,
        decode<ServerDraft>(row).content,
        "browser-draft",
      );
      const result = this.db
        .prepare(
          "UPDATE drafts SET deleted=1,payload='{}' WHERE document_path=? AND tab_id=? AND revision=? AND deleted=0",
        )
        .run(documentPath, tabId, revision);
      return Number(result.changes) > 0;
    });
  }

  private log(event: string, data: Record<string, unknown>): void {
    const file = process.env.THOUGHTFUL_SLOG_FILE;
    if (!file) return;
    try {
      fs.appendFileSync(
        file,
        `${JSON.stringify({ ts: new Date().toISOString(), source: "review-database", event, data })}\n`,
      );
    } catch {
      /* Diagnostic output cannot invalidate a committed transaction. */
    }
  }
}

export function readStoredReviewRecords(
  stateDirectory: string,
): ReviewRecord[] {
  const file = path.join(stateDirectory, "roughdraft.sqlite");
  if (!fs.existsSync(file))
    return new ReviewRegistry({ stateDir: stateDirectory }).list();
  const { DatabaseSync: SQLite } =
    require("node:sqlite") as typeof import("node:sqlite");
  const db = new SQLite(file, { readOnly: true });
  try {
    const version = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (
      (version.user_version !== 1 && version.user_version !== 2) ||
      !db
        .prepare("SELECT value FROM metadata WHERE key='legacy-imported'")
        .get()
    )
      throw new ReviewDatabaseError(
        "Roughdraft database migration is incomplete or unsupported.",
      );
    return db
      .prepare("SELECT payload FROM documents ORDER BY rowid")
      .all()
      .map((row) => decode<ReviewRecord>(row));
  } finally {
    db.close();
  }
}
