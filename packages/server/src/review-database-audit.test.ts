import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "./index";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewDatabase, readStoredReviewRecords } from "./review-database";
import { ReviewEventQueue } from "./review-events";
import { ReviewRegistry } from "./review-registry";

// Audit regressions use temporary SQLite databases and public storage methods.
// Expected failures remain visible so the integrating parent can fix the owners.
let directory: string;
let documentPath: string;
const connections = new Set<ReviewDatabase>();
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-db-audit-"));
  documentPath = path.join(directory, "review.md");
  fs.writeFileSync(documentPath, "# Review\n");
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of connections) db.close();
  connections.clear();
  fs.rmSync(directory, { recursive: true, force: true });
});
function database() {
  const db = new ReviewDatabase(directory);
  connections.add(db);
  return db;
}
function close(db: ReviewDatabase) {
  db.close();
  connections.delete(db);
}
function completion() {
  return {
    documentPath,
    projectPath: directory,
    relativePath: "review.md",
    version: "v1",
    summary: { comments: 0, replies: 0, suggestions: 0, unresolved: 0 },
  };
}

it("audit: migration preserves the high-water cursor when retained events are empty", () => {
  fs.writeFileSync(
    path.join(directory, "review-events.json"),
    JSON.stringify({ version: 1, nextSequence: 101, events: [] }),
  );
  // The legacy loader accepts this retained journal and remembers the cursor.
  expect(
    new ReviewEventQueue(
      path.join(directory, "review-events.json"),
    ).latestSequence(),
  ).toBe(100);
  const db = database();
  expect(db.loadEvents().nextSequence).toBe(101);
  expect(new ReviewEventQueue(db).emit(completion()).event.sequence).toBe(101);
});

it("audit: retrying a failed completion cannot later complete a newly opened round", () => {
  const db = database();
  const registry = new ReviewRegistry({ persistence: db });
  const queue = new ReviewEventQueue(db);
  registry.register(documentPath);
  const markdown = "# Review\n\nFeedback\n";
  const failedWrite = db.prepareWrite(documentPath, markdown, completion());
  fs.writeFileSync(documentPath, markdown);
  // Model a transient SQLite append failure after Markdown was committed.
  vi.spyOn(db, "appendEvent").mockImplementationOnce(() => {
    throw new Error("SQLITE_BUSY");
  });
  expect(() => queue.emit(completion(), failedWrite)).toThrow("SQLITE_BUSY");
  const retriedWrite = db.prepareWrite(documentPath, markdown, completion());
  queue.emit(completion(), retriedWrite);
  registry.register(documentPath);
  const nextRound = db.history(documentPath).rounds[0];
  expect(nextRound.status).toBe("pending");
  close(db);

  const restarted = database();
  const recoveredRound = restarted
    .history(documentPath)
    .rounds.find((round) => round.id === nextRound.id);
  expect({
    completionCount: restarted.loadEvents().events.length,
    reopenedRoundStatus: recoveredRound?.status,
  }).toEqual({ completionCount: 1, reopenedRoundStatus: "pending" });
});

it("audit: failed migration cannot make read-only CLI readers silently report an empty registry", () => {
  new ReviewRegistry({ stateDir: directory }).register(documentPath);
  fs.writeFileSync(path.join(directory, "review-events.json"), "{");
  expect(database).toThrow();
  // The SQLite file exists, but its legacy import never committed. Readers must
  // reject it instead of treating absent rows as authoritative review history.
  expect(() => readStoredReviewRecords(directory)).toThrow();
});

it("audit control: two registry clients join one pending document round and preserve a newer draft on stale deletion", () => {
  const db = database();
  const first = new ReviewRegistry({ persistence: db });
  const second = new ReviewRegistry({ persistence: db });
  const registered = first.register(documentPath);
  expect(second.register(documentPath).route).toBe(registered.route);
  expect(db.history(documentPath).rounds).toHaveLength(1);
  const draft = {
    storageKey: documentPath,
    content: "newer",
    baseContent: "# Review\n",
    baseVersion: null,
    revision: "tab:2",
    tabId: "tab",
    updatedAt: 200,
  };
  db.saveDraft(documentPath, draft);
  expect(db.deleteDraft(documentPath, "tab", "tab:1")).toBe(false);
  expect(db.listDrafts(documentPath)[0].content).toBe("newer");
});

it("audit: versioned Markdown PUT cannot accept a fresh baseline after the version check", async () => {
  const { app } = createApp({ stateDirectory: directory });
  connections.add(app.locals.reviewDatabase);
  const before = await request(app)
    .get("/api/markdown-file")
    .query({ projectPath: directory, path: "review.md" });
  expect(before.status).toBe(200);
  const stat = fs.statSync.bind(fs);
  let interleaved = false;
  vi.spyOn(fs, "statSync").mockImplementation((...args) => {
    const value = stat(...args);
    if (!interleaved && String(args[0]) === documentPath) {
      interleaved = true;
      // The version reader already captured the original bytes and stats.
      fs.writeFileSync(documentPath, "external edit after version read");
    }
    return value;
  });
  const response = await request(app)
    .put("/api/markdown-file")
    .query({ projectPath: directory, path: "review.md" })
    .send({
      content: "stale client content",
      expectedVersion: before.body.version,
    });
  expect(interleaved).toBe(true);
  expect({
    status: response.status,
    content: fs.readFileSync(documentPath, "utf8"),
  }).toEqual({ status: 409, content: "external edit after version read" });
});

it("audit: a concurrent restore conflict is HTTP 409 rather than a server error", async () => {
  const { app } = createApp({ stateDirectory: directory });
  const db = app.locals.reviewDatabase as ReviewDatabase;
  connections.add(db);
  await request(app).post("/api/reviews").send({ documentPath }).expect(201);
  const history = db.history(documentPath);
  const snapshot = history.snapshots[0] as { id: string };
  const preview = await request(app)
    .get(`/api/reviews/snapshots/${snapshot.id}`)
    .query({ documentPath });
  expect(preview.status).toBe(200);
  const sync = fs.fsyncSync.bind(fs);
  let interleaved = false;
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    sync(fd);
    if (!interleaved && fs.fstatSync(fd).isFile()) {
      interleaved = true;
      fs.writeFileSync(documentPath, "external edit during restore");
    }
  });
  const response = await request(app)
    .post(`/api/reviews/snapshots/${snapshot.id}/restore`)
    .send({ documentPath, expectedVersion: preview.body.currentVersion });
  expect(interleaved).toBe(true);
  expect(fs.readFileSync(documentPath, "utf8")).toBe(
    "external edit during restore",
  );
  expect(response.status).toBe(409);
});

it("audit control: parallel HTTP registrations join one round and tombstones reject exact retries", async () => {
  const { app } = createApp({ stateDirectory: directory });
  const db = app.locals.reviewDatabase as ReviewDatabase;
  connections.add(db);
  const responses = await Promise.all(
    Array.from({ length: 4 }, () =>
      request(app).post("/api/reviews").send({ documentPath }),
    ),
  );
  expect(responses.map((response) => response.status)).toEqual([
    201, 201, 201, 201,
  ]);
  expect(db.listRecords()).toHaveLength(1);
  expect(db.history(documentPath).rounds).toHaveLength(1);
  const draft = {
    storageKey: documentPath,
    content: "draft",
    baseContent: "# Review\n",
    baseVersion: null,
    revision: "tab:1",
    tabId: "tab",
    updatedAt: 100,
  };
  db.saveDraft(documentPath, draft);
  expect(db.deleteDraft(documentPath, draft.tabId, draft.revision)).toBe(true);
  expect(() => db.saveDraft(documentPath, draft)).toThrow();
  expect(db.listDrafts(documentPath)).toEqual([]);
});

it("audit: completion without an overall comment still checks the reviewed content", async () => {
  const { app } = createApp({ stateDirectory: directory });
  const db = app.locals.reviewDatabase as ReviewDatabase;
  connections.add(db);
  await request(app).post("/api/reviews").send({ documentPath }).expect(201);
  const prepare = db.prepareWrite.bind(db);
  vi.spyOn(db, "prepareWrite").mockImplementationOnce((...args) => {
    const id = prepare(...args);
    fs.writeFileSync(
      documentPath,
      "# Externally replaced\n\n{>>New unresolved feedback<<}\n",
    );
    return id;
  });
  const response = await request(app)
    .post("/api/review-events")
    .send({ projectPath: directory, path: "review.md" });
  expect({
    status: response.status,
    completionCount: db.loadEvents().events.length,
    roundStatus: db.history(documentPath).rounds[0].status,
  }).toEqual({ status: 409, completionCount: 0, roundStatus: "pending" });
});
