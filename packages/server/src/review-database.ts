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
interface PendingWrite {
  id: string;
  documentPath: string;
  before: string;
  after: string;
  completion?: ReviewCompletedEventInput;
  roundId?: string;
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
      if (version.user_version > 1)
        throw new ReviewDatabaseError(
          "Roughdraft database was created by a newer version.",
        );
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS documents (document_path TEXT PRIMARY KEY, route TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS rounds (id TEXT PRIMARY KEY, document_path TEXT NOT NULL, opened_at TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS rounds_document ON rounds(document_path, opened_at);
        CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY, document_path TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_document ON events(document_path, sequence);
        CREATE TABLE IF NOT EXISTS acknowledgements (sequence INTEGER NOT NULL REFERENCES events(sequence), consumer_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('received','processed')), updated_at TEXT NOT NULL, PRIMARY KEY(sequence, consumer_id));
        CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, document_path TEXT NOT NULL, version TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, reason TEXT NOT NULL, UNIQUE(document_path, version));
        CREATE TABLE IF NOT EXISTS file_writes (id TEXT PRIMARY KEY, document_path TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS drafts (document_path TEXT NOT NULL, tab_id TEXT NOT NULL, revision TEXT NOT NULL, updated_at REAL NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL, PRIMARY KEY(document_path, tab_id));
        PRAGMA user_version=1;
      `);
      this.importLegacy(stateDirectory);
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
        // Multiple agents opening a still-pending document join the same round.
        const pending = this.currentRound(record.documentPath);
        if (!pending || pending.status === "completed") {
          const content = fs.readFileSync(record.documentPath, "utf8");
          this.snapshot(record.documentPath, content, "opened");
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
      if (write?.roundId && round?.status === "completed")
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
      if (round)
        this.insertRound({
          ...round,
          status: "completed",
          completedAt: event.createdAt,
          completedVersion: event.version,
          eventSequence: event.sequence,
        });
      if (writeId) this.finishWriteInternal(writeId);
      if (round)
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
  ): void {
    this.db
      .prepare("INSERT OR IGNORE INTO snapshots VALUES(?,?,?,?,?,?)")
      .run(
        randomUUID(),
        documentPath,
        hash(content),
        content,
        new Date().toISOString(),
        reason,
      );
  }

  prepareWrite(
    documentPath: string,
    content: string,
    completion?: ReviewCompletedEventInput,
  ): string {
    documentPath = canonical(documentPath);
    const before = fs.readFileSync(documentPath, "utf8");
    const write: PendingWrite = {
      id: randomUUID(),
      documentPath,
      before,
      after: content,
      completion,
      createdAt: new Date().toISOString(),
    };
    this.transaction(() => {
      if (completion) {
        let round = this.currentRound(documentPath);
        if (!round || round.status === "completed") {
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

  history(documentPath: string) {
    documentPath = canonical(documentPath);
    return {
      rounds: this.db
        .prepare(
          "SELECT payload FROM rounds WHERE document_path=? ORDER BY rowid DESC",
        )
        .all(documentPath)
        .map((row) => decode<ReviewRound>(row)),
      snapshots: this.db
        .prepare(
          "SELECT id,document_path AS documentPath,version,created_at AS createdAt,reason FROM snapshots WHERE document_path=? ORDER BY rowid DESC",
        )
        .all(documentPath),
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
      return { ...draft, documentPath };
    });
  }

  deleteDraft(documentPath: string, tabId: string, revision: string): boolean {
    documentPath = canonical(documentPath);
    // Retain the revision tombstone so a delayed retry cannot resurrect it.
    const result = this.db
      .prepare(
        "UPDATE drafts SET deleted=1,payload='{}' WHERE document_path=? AND tab_id=? AND revision=? AND deleted=0",
      )
      .run(documentPath, tabId, revision);
    return Number(result.changes) > 0;
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
      version.user_version !== 1 ||
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
