import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApp } from "./index";
import type { ReviewDatabase } from "./review-database";

// Real filesystem + HTTP protect the observation/save boundary; no timing sleeps.
let directory: string;
let file: string;
let app: ReturnType<typeof createApp>["app"];
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-revisions-"));
  file = path.join(directory, "review.md");
  fs.writeFileSync(file, "A\n");
  app = createApp({ stateDirectory: path.join(directory, "state") }).app;
});
afterEach(() => {
  app.locals.reviewDatabase.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
const checkpoints = async () =>
  (
    await request(app)
      .get("/api/reviews/revisions")
      .query({ documentPath: file })
      .expect(200)
  ).body.checkpoints;
const load = () =>
  request(app)
    .get("/api/markdown-file")
    .query({ projectPath: directory, path: "review.md" })
    .expect(200);

it("records ordered external revisions and reverts, deduplicates reloads, and persists across restart", async () => {
  await load();
  await load();
  fs.writeFileSync(file, "B\n");
  await load();
  fs.writeFileSync(file, "A\n");
  const before = await checkpoints();
  expect(
    before.map((r: { number: number; content: string; source: string }) => [
      r.number,
      r.content,
      r.source,
    ]),
  ).toEqual([
    [0, "A\n", "baseline"],
    [1, "B\n", "external"],
    [2, "A\n", "external"],
  ]);
  expect(new Set(before.map((r: { id: string }) => r.id)).size).toBe(3);
  expect(before[0].version).toBe(before[2].version);
  app.locals.reviewDatabase.close();
  app = createApp({ stateDirectory: path.join(directory, "state") }).app;
  expect(await checkpoints()).toEqual(before);
});

it("captures edits during polling even if no content GET happens between them", async () => {
  const poll = () =>
    request(app)
      .get("/api/markdown-file/events")
      .query({ projectPath: directory, path: "review.md", poll: "1" })
      .expect(200);
  await poll();
  fs.writeFileSync(file, "B\n");
  await poll();
  fs.writeFileSync(file, "C\n");
  expect(
    (await checkpoints()).map((r: { content: string }) => r.content),
  ).toEqual(["A\n", "B\n", "C\n"]);
});

it("seeds registration and page reads; records successful saves and completion, but not rejected proposals", async () => {
  await request(app)
    .post("/api/reviews")
    .send({ documentPath: file })
    .expect(201);
  await request(app)
    .get("/api/pages/review")
    .query({ projectPath: directory })
    .expect(200);
  await request(app)
    .put("/api/markdown-file")
    .query({ projectPath: directory, path: "review.md" })
    .send({ content: "B\n" })
    .expect(200);
  await request(app)
    .put("/api/markdown-file")
    .query({ projectPath: directory, path: "review.md" })
    .send({ content: "Rejected\n", expectedVersion: "stale" })
    .expect(409);
  await request(app)
    .post("/api/review-events")
    .send({
      projectPath: directory,
      path: "review.md",
      overallComment: "Needs detail",
    })
    .expect(201);
  const result = await checkpoints();
  expect(result.map((r: { source: string }) => r.source)).toEqual([
    "baseline",
    "review",
    "review",
  ]);
  expect(result[1].content).toBe("B\n");
  expect(result[2].content).toContain("Needs detail");
  expect(
    result.some((r: { content: string }) => r.content === "Rejected\n"),
  ).toBe(false);
});

it("never records prepared or cancelled bytes; recovers a confirmed crash write only once", () => {
  const db: ReviewDatabase = app.locals.reviewDatabase;
  const cancelled = db.prepareWrite(file, "Cancelled");
  db.cancelWrite(cancelled);
  db.prepareWrite(file, "Never written");
  expect(db.revisions(file).map((r) => r.content)).toEqual(["A\n"]);
  db.prepareWrite(file, "Written before crash");
  fs.writeFileSync(file, "Written before crash");
  db.close();
  app = createApp({ stateDirectory: path.join(directory, "state") }).app;
  expect(
    app.locals.reviewDatabase
      .revisions(file)
      .map((r: { content: string; source: string }) => [r.content, r.source]),
  ).toEqual([
    ["A\n", "baseline"],
    ["Written before crash", "review"],
  ]);
  app.locals.reviewDatabase.close();
  app = createApp({ stateDirectory: path.join(directory, "state") }).app;
  expect(app.locals.reviewDatabase.revisions(file)).toHaveLength(2);
});

it("requires an existing local Markdown file", async () => {
  await request(app)
    .get("/api/reviews/revisions")
    .query({ documentPath: "relative.md" })
    .expect(400);
  await request(app)
    .get("/api/reviews/revisions")
    .query({ documentPath: path.join(directory, "missing.md") })
    .expect(404);
  fs.mkdirSync(path.join(directory, "folder.md"));
  await request(app)
    .get("/api/reviews/revisions")
    .query({ documentPath: path.join(directory, "folder.md") })
    .expect(400);
});
