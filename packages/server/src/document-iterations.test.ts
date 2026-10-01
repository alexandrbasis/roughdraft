import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApp } from "./index";

let directory: string;
let file: string;
let app: ReturnType<typeof createApp>["app"];
let server: Server;

async function startTestServer() {
  server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function stopTestServer() {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-iterations-"));
  file = path.join(directory, "review.md");
  fs.writeFileSync(file, "# Agent scaffold\n");
  app = createApp({ stateDirectory: path.join(directory, "state") }).app;
  await startTestServer();
});

afterEach(async () => {
  await stopTestServer();
  app.locals.reviewDatabase.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function observeDocument() {
  await request(server)
    .get("/api/markdown-file")
    .query({ projectPath: directory, path: "review.md" })
    .expect(200);
}

async function saveDocument(content: string) {
  await request(server)
    .put("/api/markdown-file")
    .query({ projectPath: directory, path: "review.md" })
    .send({ content })
    .expect(200);
}

it("shows one version per completed actor iteration despite intermediate file writes", async () => {
  await observeDocument();
  fs.writeFileSync(file, "# Agent draft\n");
  await observeDocument();
  fs.writeFileSync(file, "# Ready for review\n");
  await observeDocument();

  await request(server)
    .post("/api/reviews")
    .send({ documentPath: file })
    .expect(201);

  await saveDocument("# Ready for review\n\nFirst user edit.\n");
  await saveDocument("# Ready for review\n\nFinal user edit.\n");
  // Another agent joining the pending review must not relabel autosaved user
  // bytes as an agent handoff.
  await request(server)
    .post("/api/reviews")
    .send({ documentPath: file })
    .expect(201);
  const editing = await request(server)
    .get("/api/reviews/document")
    .query({ documentPath: file })
    .expect(200);
  expect(editing.body).toMatchObject({
    content: "# Ready for review\n\nFinal user edit.\n",
    editingState: "editing",
    iterations: [{ number: 1, actor: "agent" }],
    currentIteration: { number: 2, actor: "user" },
  });
  expect(editing.body.checkpoints).toHaveLength(5);
  expect(editing.body.recoveryPoints.length).toBeGreaterThan(0);
  const status = await request(server).get("/api/reviews").expect(200);
  expect(status.body[0].status).toBe("pending");

  await request(server)
    .post("/api/review-events")
    .send({ projectPath: directory, path: "review.md" })
    .expect(201);

  const response = await request(server)
    .get("/api/reviews/revisions")
    .query({ documentPath: file })
    .expect(200);

  expect(
    response.body.revisions.map(
      ({ number, content }: { number: number; content: string }) => ({
        number,
        content,
      }),
    ),
  ).toEqual([
    { number: 1, content: "# Ready for review\n" },
    { number: 2, content: "# Ready for review\n\nFinal user edit.\n" },
  ]);
  expect(response.body.checkpoints).toHaveLength(5);
  const completed = await request(server)
    .get("/api/reviews/document")
    .query({ documentPath: file })
    .expect(200);
  expect(completed.body.editingState).toBe("completed");
  expect(completed.body.currentIteration).toBeNull();
});

it("keeps intermediate agent file writes as restorable recovery points before handoff", async () => {
  await observeDocument();
  fs.writeFileSync(file, "# Agent draft one\n");
  await observeDocument();
  fs.writeFileSync(file, "# Agent draft two\n");
  await observeDocument();

  const beforeHandoff = await request(server)
    .get("/api/reviews/revisions")
    .query({ documentPath: file })
    .expect(200);
  expect(beforeHandoff.body.checkpoints).toHaveLength(3);
  for (const content of ["# Agent scaffold\n", "# Agent draft one\n"]) {
    const point = beforeHandoff.body.recoveryPoints.find(
      (entry: { content: string }) => entry.content === content,
    );
    expect(point, `Missing recovery point for ${content.trim()}`).toBeTruthy();
    const snapshot = await request(server)
      .get(`/api/reviews/snapshots/${point.id}`)
      .query({ documentPath: file })
      .expect(200);
    expect(snapshot.body.content).toBe(content);
  }

  await request(server)
    .post("/api/reviews")
    .send({ documentPath: file })
    .expect(201);
  const afterHandoff = await request(server)
    .get("/api/reviews/revisions")
    .query({ documentPath: file })
    .expect(200);
  expect(afterHandoff.body.revisions).toMatchObject([
    { number: 1, actor: "agent", content: "# Agent draft two\n" },
  ]);
  const earlier = afterHandoff.body.recoveryPoints.find(
    (entry: { content: string }) => entry.content === "# Agent draft one\n",
  );
  const preview = await request(server)
    .get(`/api/reviews/snapshots/${earlier.id}`)
    .query({ documentPath: file })
    .expect(200);
  await request(server)
    .post(`/api/reviews/snapshots/${earlier.id}/restore`)
    .send({ documentPath: file, expectedVersion: preview.body.currentVersion })
    .expect(200, { restored: true });
  expect(fs.readFileSync(file, "utf8")).toBe("# Agent draft one\n");
});

it("records a no-change approval as a user iteration and keeps unchanged reopens idempotent", async () => {
  await request(server)
    .post("/api/reviews")
    .send({ documentPath: file })
    .expect(201);
  await request(server)
    .post("/api/review-events")
    .send({ projectPath: directory, path: "review.md" })
    .expect(201);
  await request(server)
    .post("/api/review-events")
    .send({ projectPath: directory, path: "review.md" })
    .expect(201);
  await request(server)
    .post("/api/reviews")
    .send({ documentPath: file })
    .expect(201);
  await request(server)
    .post("/api/reviews")
    .send({ documentPath: file })
    .expect(201);

  let response = await request(server)
    .get("/api/reviews/revisions")
    .query({ documentPath: file })
    .expect(200);
  expect(
    response.body.revisions.map(
      ({
        number,
        actor,
        content,
      }: {
        number: number;
        actor: string;
        content: string;
      }) => ({
        number,
        actor,
        content,
      }),
    ),
  ).toEqual([
    { number: 1, actor: "agent", content: "# Agent scaffold\n" },
    { number: 2, actor: "user", content: "# Agent scaffold\n" },
  ]);

  fs.writeFileSync(file, "# Agent revision\n");
  await request(server)
    .post("/api/reviews")
    .send({ documentPath: file })
    .expect(201);
  response = await request(server)
    .get("/api/reviews/revisions")
    .query({ documentPath: file })
    .expect(200);
  expect(
    response.body.revisions.map(
      (iteration: { number: number }) => iteration.number,
    ),
  ).toEqual([1, 2, 3]);
  expect(response.body.revisions[2]).toMatchObject({
    actor: "agent",
    content: "# Agent revision\n",
  });
});

it("retains a discarded browser draft as a restorable recovery point", async () => {
  const initial = await request(server)
    .get("/api/reviews/revisions")
    .query({ documentPath: file })
    .expect(200);
  expect(initial.body.revisions).toMatchObject([
    { number: 1, actor: "unknown", author: "Original", completedAt: null },
  ]);

  const draft = {
    storageKey: file,
    content: "# Discarded browser edition\n",
    baseContent: "# Agent scaffold\n",
    baseVersion: null,
    revision: "draft:1",
    tabId: "browser-a",
    updatedAt: Date.now(),
  };
  await request(server)
    .put("/api/reviews/drafts")
    .send({ documentPath: file, draft })
    .expect(200);
  await request(server)
    .delete("/api/reviews/drafts")
    .send({ documentPath: file, tabId: draft.tabId, revision: draft.revision })
    .expect(200, { deleted: true });
  const document = await request(server)
    .get("/api/reviews/document")
    .query({ documentPath: file })
    .expect(200);
  expect(document.body.editingState).toBe("editing");
  expect(document.body.drafts).toEqual([]);
  const point = document.body.recoveryPoints.find(
    (entry: { content: string }) => entry.content === draft.content,
  );
  expect(point).toMatchObject({ reason: "browser-draft" });
  const snapshot = await request(server)
    .get(`/api/reviews/snapshots/${point.id}`)
    .query({ documentPath: file })
    .expect(200);
  expect(snapshot.body.content).toBe(draft.content);
});

it("keeps rapid draft edits durable without making a recovery point for every edit", async () => {
  const updatedAt = Date.now();
  const tabId = "rapid-browser-edits";
  const contents = Array.from(
    { length: 8 },
    (_, index) => `# Browser edition ${index + 1}\n`,
  );
  for (const [index, content] of contents.entries()) {
    await request(server)
      .put("/api/reviews/drafts")
      .send({
        documentPath: file,
        draft: {
          storageKey: file,
          content,
          baseContent: "# Agent scaffold\n",
          baseVersion: null,
          revision: `draft:${index + 1}`,
          tabId,
          updatedAt: updatedAt + index,
        },
      })
      .expect(200);
  }

  // The latest draft must survive reopening the server, regardless of how
  // often permanent recovery points are sampled.
  await stopTestServer();
  app.locals.reviewDatabase.close();
  app = createApp({ stateDirectory: path.join(directory, "state") }).app;
  await startTestServer();

  const current = await request(server)
    .get("/api/reviews/document")
    .query({ documentPath: file })
    .expect(200);
  expect(current.body.drafts).toMatchObject([
    { content: contents.at(-1), revision: "draft:8", tabId },
  ]);
  expect(
    current.body.recoveryPoints.filter(
      (point: { reason: string }) => point.reason === "browser-draft",
    ).length,
  ).toBeLessThanOrEqual(1);

  await request(server)
    .delete("/api/reviews/drafts")
    .send({ documentPath: file, tabId, revision: "draft:8" })
    .expect(200, { deleted: true });
  const discarded = await request(server)
    .get("/api/reviews/document")
    .query({ documentPath: file })
    .expect(200);
  expect(discarded.body.drafts).toEqual([]);
  const latestPoint = discarded.body.recoveryPoints.find(
    (point: { content: string }) => point.content === contents.at(-1),
  );
  expect(latestPoint).toMatchObject({ reason: "browser-draft" });
  const snapshot = await request(server)
    .get(`/api/reviews/snapshots/${latestPoint.id}`)
    .query({ documentPath: file })
    .expect(200);
  expect(snapshot.body.content).toBe(contents.at(-1));
});

it("promotes a provisional Original V1 on the first unchanged agent delivery", async () => {
  const before = await request(server)
    .get("/api/reviews/revisions")
    .query({ documentPath: file })
    .expect(200);
  expect(before.body.revisions).toMatchObject([
    { number: 1, actor: "unknown", completedAt: null },
  ]);
  await request(server)
    .post("/api/reviews")
    .send({ documentPath: file })
    .expect(201);
  const after = await request(server)
    .get("/api/reviews/revisions")
    .query({ documentPath: file })
    .expect(200);
  expect(after.body.revisions).toHaveLength(1);
  expect(after.body.revisions[0]).toMatchObject({
    id: before.body.revisions[0].id,
    number: 1,
    actor: "agent",
    author: "Agent",
    createdAt: before.body.revisions[0].createdAt,
  });
  expect(after.body.revisions[0].completedAt).toEqual(expect.any(String));
});

it("completes a new agent handoff after an external write during unfinished user editing", async () => {
  await request(server)
    .post("/api/reviews")
    .send({ documentPath: file })
    .expect(201);
  await saveDocument("# User autosave\n");
  fs.writeFileSync(file, "# New agent edition\n");
  await request(server)
    .post("/api/reviews")
    .send({ documentPath: file })
    .expect(201);
  const response = await request(server)
    .get("/api/reviews/document")
    .query({ documentPath: file })
    .expect(200);
  expect(response.body.iterations).toMatchObject([
    { number: 1, actor: "agent", content: "# Agent scaffold\n" },
    { number: 2, actor: "agent", content: "# New agent edition\n" },
  ]);
  expect(
    response.body.checkpoints.some(
      (entry: { content: string }) => entry.content === "# User autosave\n",
    ),
  ).toBe(true);
  expect(response.body.editingState).toBe("awaiting-review");
});

it("keeps the original direct-path bytes as V1 when the first version read follows a save", async () => {
  await observeDocument();
  await saveDocument("# Browser edit\n");
  const response = await request(server)
    .get("/api/reviews/document")
    .query({ documentPath: file })
    .expect(200);
  expect(response.body.iterations).toMatchObject([
    { number: 1, actor: "unknown", content: "# Agent scaffold\n" },
  ]);
  expect(response.body.currentIteration).toMatchObject({
    number: 2,
    actor: "user",
    content: "# Browser edit\n",
  });
});

it("does not reopen editing for a late mirror of completed bytes", async () => {
  await request(server)
    .post("/api/reviews")
    .send({ documentPath: file })
    .expect(201);
  await request(server)
    .post("/api/review-events")
    .send({ projectPath: directory, path: "review.md" })
    .expect(201);
  const draft = {
    storageKey: file,
    content: "# Agent scaffold\n",
    baseContent: "# Agent scaffold\n",
    baseVersion: null,
    revision: "late:1",
    tabId: "late-tab",
    updatedAt: Date.now(),
  };
  await request(server)
    .put("/api/reviews/drafts")
    .send({ documentPath: file, draft })
    .expect(200);
  await request(server)
    .delete("/api/reviews/drafts")
    .send({ documentPath: file, tabId: draft.tabId, revision: draft.revision })
    .expect(200, { deleted: true });
  let document = await request(server)
    .get("/api/reviews/document")
    .query({ documentPath: file })
    .expect(200);
  expect(document.body.editingState).toBe("completed");

  await request(server)
    .put("/api/reviews/drafts")
    .send({
      documentPath: file,
      draft: {
        ...draft,
        content: "New tab edit",
        revision: "late:2",
        updatedAt: Date.now() + 1,
      },
    })
    .expect(200);
  document = await request(server)
    .get("/api/reviews/document")
    .query({ documentPath: file })
    .expect(200);
  expect(document.body.editingState).toBe("editing");
});

it("archives a delayed pre-completion draft without reopening editing", async () => {
  await request(server)
    .post("/api/reviews")
    .send({ documentPath: file })
    .expect(201);
  const draft = {
    storageKey: file,
    content: "# Earlier browser draft\n",
    baseContent: "# Agent scaffold\n",
    baseVersion: null,
    revision: "before-done:1",
    tabId: "delayed-tab",
    updatedAt: Date.now() - 10_000,
  };
  await request(server)
    .post("/api/review-events")
    .send({
      projectPath: directory,
      path: "review.md",
      overallComment: "Approved",
    })
    .expect(201);
  await request(server)
    .put("/api/reviews/drafts")
    .send({ documentPath: file, draft })
    .expect(200);
  const document = await request(server)
    .get("/api/reviews/document")
    .query({ documentPath: file })
    .expect(200);
  expect(document.body.editingState).toBe("completed");
  expect(document.body.drafts).toEqual([]);
  expect(document.body.recoveryPoints).toContainEqual(
    expect.objectContaining({
      content: draft.content,
      reason: "browser-draft",
    }),
  );
});

it("rejects Done when the saved file changed after the browser observed its version", async () => {
  await request(server)
    .post("/api/reviews")
    .send({ documentPath: file })
    .expect(201);
  const loaded = await request(server)
    .get("/api/markdown-file")
    .query({ projectPath: directory, path: "review.md" })
    .expect(200);
  fs.writeFileSync(file, "# External write after browser save\n");

  await request(server)
    .post("/api/review-events")
    .send({
      projectPath: directory,
      path: "review.md",
      expectedVersion: loaded.body.version,
    })
    .expect(409);

  const document = await request(server)
    .get("/api/reviews/document")
    .query({ documentPath: file })
    .expect(200);
  expect(document.body.content).toBe("# External write after browser save\n");
  expect(document.body.iterations).toHaveLength(1);
  expect(document.body.editingState).toBe("awaiting-review");
  const status = await request(server).get("/api/reviews").expect(200);
  expect(status.body[0].status).toBe("pending");
});

it("upgrades a checkpoint-only database to an unknown V1 without losing checkpoints", async () => {
  await observeDocument();
  fs.writeFileSync(file, "# Latest legacy checkpoint\n");
  await observeDocument();
  const before = await request(server)
    .get("/api/reviews/revisions")
    .query({ documentPath: file })
    .expect(200);
  const observedAt = before.body.checkpoints.at(-1).createdAt;
  await stopTestServer();
  app.locals.reviewDatabase.close();

  // Model a v1 database with existing file observations and no iteration
  // provenance. The upgrade may label only its current baseline as unknown.
  const sqlite = new DatabaseSync(
    path.join(directory, "state", "roughdraft.sqlite"),
  );
  sqlite.exec(
    "DELETE FROM document_iterations; DELETE FROM document_iteration_state; PRAGMA user_version=1;",
  );
  sqlite.close();
  app = createApp({ stateDirectory: path.join(directory, "state") }).app;
  await startTestServer();

  const result = await request(server)
    .get("/api/reviews/revisions")
    .query({ documentPath: file })
    .expect(200);
  expect(
    result.body.checkpoints.map((entry: { content: string }) => entry.content),
  ).toEqual(["# Agent scaffold\n", "# Latest legacy checkpoint\n"]);
  expect(result.body.revisions).toMatchObject([
    {
      number: 1,
      actor: "unknown",
      author: "Original",
      content: "# Latest legacy checkpoint\n",
      createdAt: observedAt,
      completedAt: null,
    },
  ]);
  for (const content of [
    "# Agent scaffold\n",
    "# Latest legacy checkpoint\n",
  ]) {
    const point = result.body.recoveryPoints.find(
      (entry: { content: string }) => entry.content === content,
    );
    expect(
      point,
      `Legacy checkpoint missing from recovery: ${content.trim()}`,
    ).toBeTruthy();
    const snapshot = await request(server)
      .get(`/api/reviews/snapshots/${point.id}`)
      .query({ documentPath: file })
      .expect(200);
    expect(snapshot.body.content).toBe(content);
  }
});
