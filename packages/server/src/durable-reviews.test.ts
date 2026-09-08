import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApp } from "./index";
import { callTool } from "./mcp";
import { ReviewEventQueue } from "./review-events";
import { ReviewRegistry } from "./review-registry";

let directory: string;
let project: string;
let stateDirectory: string;
let documentPath: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "durable-reviews-"));
  project = path.join(directory, "admitad-one");
  stateDirectory = path.join(directory, "state");
  fs.mkdirSync(project);
  documentPath = path.join(project, "draft.md");
  fs.writeFileSync(documentPath, "# AppsFlyer\n");
});

afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

it("preserves a readable route, completion, and replay cursor across server recreation", async () => {
  const first = createApp({ stateDirectory }).app;
  const registered = await request(first)
    .post("/api/reviews")
    .send({ documentPath });
  expect(registered.status).toBe(201);
  expect(registered.body).toMatchObject({
    route: "/admitad-one/appsflyer",
    afterSequence: 0,
    status: "pending",
  });

  const done = await request(first).post("/api/review-events").send({
    projectPath: project,
    path: "draft.md",
    overallComment: "Please clarify the event mapping.",
  });
  expect(done.status).toBe(201);

  const restarted = createApp({ stateDirectory }).app;
  const replay = await request(restarted)
    .post("/api/review-events/watch")
    .send({
      projectPath: project,
      path: "draft.md",
      afterSequence: registered.body.afterSequence,
      fromNow: false,
      timeoutSeconds: 0,
      batchWindowSeconds: 0,
    });
  expect(replay.body).toMatchObject({
    timedOut: false,
    events: [{ sequence: done.body.event.sequence, documentPath }],
  });
  expect(fs.readFileSync(documentPath, "utf8")).toContain(
    "Please clarify the event mapping.",
  );
  const resolved = await request(restarted)
    .get("/api/reviews/resolve")
    .query({ route: registered.body.route });
  expect(resolved.body).toMatchObject({
    status: "completed",
    documentPath: fs.realpathSync(documentPath),
  });
  const known = await callTool(
    "roughdraft_get_open_documents",
    {},
    { ROUGHDRAFT_STATE_DIR: stateDirectory },
    fetch,
  );
  expect(known).toMatchObject({
    documents: [{ route: registered.body.route, status: "completed" }],
  });
  const reopened = await request(restarted)
    .post("/api/reviews")
    .send({ documentPath });
  expect(reopened.body).toMatchObject({
    route: registered.body.route,
    status: "pending",
    afterSequence: done.body.event.sequence,
  });
  // Simulate reopening within the same clock millisecond as the prior Done.
  restarted.locals.reviewDatabase.saveRecord(
    { ...reopened.body, openedAt: done.body.event.createdAt },
    false,
  );
  const reopenedServer = createApp({ stateDirectory }).app;
  expect(
    (await request(reopenedServer).get("/api/reviews")).body,
  ).toMatchObject([{ status: "pending" }]);
});

it("keeps default in-memory app instances independent", async () => {
  const first = createApp().app;
  const second = createApp().app;
  await request(first).post("/api/reviews").send({ documentPath }).expect(201);
  expect((await request(second).get("/api/reviews")).body).toEqual([]);
});

it("migrates a legacy inbox entry if the old process stopped after journaling Done", async () => {
  new ReviewRegistry({ stateDir: stateDirectory }).register(documentPath, {
    afterSequence: 0,
  });
  const queue = new ReviewEventQueue(
    path.join(stateDirectory, "review-events.json"),
  );
  queue.emit({
    documentPath,
    projectPath: project,
    relativePath: "draft.md",
    version: "fixture",
    summary: { comments: 0, replies: 0, suggestions: 0, unresolved: 0 },
  });
  const restarted = createApp({ stateDirectory }).app;
  const response = await request(restarted).get("/api/reviews");
  expect(response.body).toMatchObject([{ status: "completed" }]);
});

it("reports lost or replaced history instead of silently waiting behind an impossible cursor", async () => {
  const app = createApp({ stateDirectory }).app;
  const response = await request(app).post("/api/review-events/watch").send({
    projectPath: project,
    path: "draft.md",
    fromNow: false,
    afterSequence: 27,
    timeoutSeconds: 0,
  });
  expect(response.status).toBe(409);
  expect(response.body.code).toBe("REVIEW_CURSOR_AHEAD");
});
