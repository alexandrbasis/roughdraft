import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ReviewDatabase } from "./review-database";
import { ReviewRegistry } from "./review-registry";
import { ReviewEventQueue } from "./review-events";

let dir: string;
let file: string;
const opened: ReviewDatabase[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-sqlite-"));
  file = path.join(dir, "review.md");
  fs.writeFileSync(file, "# Review\n\nOriginal\n");
});
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
function database() {
  const db = new ReviewDatabase(dir);
  opened.push(db);
  return db;
}
function input() {
  return {
    documentPath: file,
    projectPath: dir,
    relativePath: "review.md",
    version: "v1",
    summary: { comments: 0, replies: 0, suggestions: 0, unresolved: 0 },
  };
}

it("migrates legacy records and event cursors once without removing the originals", () => {
  const registry = new ReviewRegistry({ stateDir: dir });
  const record = registry.register(file);
  const queue = new ReviewEventQueue(path.join(dir, "review-events.json"));
  const event = queue.emit(input()).event;
  const db = database();
  expect(db.listRecords()[0]).toMatchObject({
    route: record.route,
    status: "completed",
  });
  expect(db.loadEvents().events).toEqual([event]);
  expect(fs.existsSync(path.join(dir, "review-registry.json"))).toBe(true);
  expect(
    fs
      .readFileSync(path.join(dir, "roughdraft.sqlite"))
      .subarray(0, 16)
      .toString(),
  ).toBe("SQLite format 3\0");
  fs.writeFileSync(path.join(dir, "review-events.json"), "not json anymore");
  expect(database().loadEvents().nextSequence).toBe(2);
});

it("rejects corrupt legacy input without committing a partially imported database", () => {
  new ReviewRegistry({ stateDir: dir }).register(file);
  fs.writeFileSync(path.join(dir, "review-events.json"), "{");
  expect(database).toThrow();
  fs.unlinkSync(path.join(dir, "review-events.json"));
  expect(database().listRecords()).toHaveLength(1);
});

it("preserves the legacy cursor even when no retained event reaches it", () => {
  fs.writeFileSync(
    path.join(dir, "review-events.json"),
    JSON.stringify({ version: 1, nextSequence: 42, events: [] }),
  );
  const db = database();
  expect(db.loadEvents().nextSequence).toBe(42);
  expect(new ReviewEventQueue(db).emit(input()).event.sequence).toBe(42);
});

it("stores separate rounds and monotonic, consumer-specific acknowledgements across reopening", () => {
  const db = database();
  const registry = new ReviewRegistry({ persistence: db });
  const queue = new ReviewEventQueue(db);
  registry.register(file);
  const event = queue.emit(input()).event;
  expect(db.listRecords()[0].status).toBe("completed");
  db.acknowledge(event.sequence, "agent-a", "processed");
  expect(db.acknowledge(event.sequence, "agent-a", "received").status).toBe(
    "processed",
  );
  expect(db.acknowledge(event.sequence, "agent-b", "received").status).toBe(
    "received",
  );
  registry.register(file);
  expect(database().history(file).rounds).toHaveLength(2);
  expect(db.history(file).acknowledgements).toHaveLength(2);
  expect(() => db.acknowledge(999, "agent-a", "processed")).toThrow();
});

it("recovers a completion committed to Markdown before the daemon crashed", () => {
  const db = database();
  new ReviewRegistry({ persistence: db }).register(file);
  db.prepareWrite(file, "# Review\n\nWith feedback\n", input());
  fs.writeFileSync(file, "# Review\n\nWith feedback\n");
  const restarted = database();
  expect(restarted.loadEvents().events).toHaveLength(1);
  expect(restarted.listRecords()[0].status).toBe("completed");
  expect(restarted.history(file).snapshots).toHaveLength(2);
  expect(database().loadEvents().events).toHaveLength(1);
});

it("preserves an external edit while retaining both snapshots of an interrupted write", () => {
  const db = database();
  db.prepareWrite(file, "Planned replacement");
  fs.writeFileSync(file, "External edit");
  expect(database().history(file).writes[0].status).toBe("conflict");
  expect(fs.readFileSync(file, "utf8")).toBe("External edit");
  expect(db.history(file).snapshots).toHaveLength(2);
});

it("retains new drafts and prevents a delayed PUT from resurrecting a deleted revision", () => {
  const db = database();
  const draft = {
    storageKey: file,
    content: "new",
    baseContent: "old",
    baseVersion: null,
    revision: "r1",
    tabId: "tab",
    updatedAt: 10,
  };
  db.saveDraft(file, draft);
  expect(db.deleteDraft(file, "tab", "wrong")).toBe(false);
  expect(db.deleteDraft(file, "tab", "r1")).toBe(true);
  expect(() => db.saveDraft(file, draft)).toThrow();
  db.saveDraft(file, { ...draft, revision: "r2", updatedAt: 11 });
  expect(database().listDrafts(file)[0].revision).toBe("r2");
});
