import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApp } from "./index";

let directory: string;
let file: string;
let app: ReturnType<typeof createApp>["app"];
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-history-api-"));
  file = path.join(directory, "review.md");
  fs.writeFileSync(file, "# Before\n");
  app = createApp({ stateDirectory: path.join(directory, "state") }).app;
});
afterEach(() => {
  app.locals.reviewDatabase.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("creates round history, snapshots and explicit received/processed acknowledgements through HTTP", async () => {
  await request(app)
    .post("/api/reviews")
    .send({ documentPath: file })
    .expect(201);
  await request(app)
    .post("/api/reviews")
    .send({ documentPath: file })
    .expect(201);
  const done = await request(app)
    .post("/api/review-events")
    .send({
      projectPath: directory,
      path: "review.md",
      overallComment: "Update the example.",
    })
    .expect(201);
  const sequence = done.body.event.sequence;
  expect(done.body.event.roundId).toBeTruthy();
  await request(app)
    .post("/api/review-events/ack")
    .send({ sequence, consumerId: "agent-a", status: "received" })
    .expect(200);
  let history = await request(app)
    .get("/api/reviews/history")
    .query({ documentPath: file })
    .expect(200);
  expect(history.body.rounds).toHaveLength(1);
  expect(history.body.rounds[0].status).toBe("completed");
  expect(history.body.acknowledgements[0].status).toBe("received");
  await request(app)
    .post("/api/review-events/ack")
    .send({ sequence, consumerId: "agent-a", status: "processed" })
    .expect(200);
  await request(app)
    .post("/api/reviews")
    .send({ documentPath: file })
    .expect(201);
  history = await request(app)
    .get("/api/reviews/history")
    .query({ documentPath: file })
    .expect(200);
  expect(history.body.rounds).toHaveLength(2);
  expect(history.body.snapshots).toHaveLength(2);
  expect(history.body.acknowledgements[0].status).toBe("processed");
});

it("restores a prior snapshot only against the version the user inspected", async () => {
  await request(app)
    .post("/api/reviews")
    .send({ documentPath: file })
    .expect(201);
  await request(app)
    .put("/api/markdown-file")
    .query({ projectPath: directory, path: "review.md" })
    .send({ content: "# After\n" })
    .expect(200);
  const history = await request(app)
    .get("/api/reviews/history")
    .query({ documentPath: file });
  const before = history.body.snapshots.find(
    (snapshot: { reason: string }) => snapshot.reason === "opened",
  );
  const snapshot = await request(app)
    .get(`/api/reviews/snapshots/${before.id}`)
    .query({ documentPath: file })
    .expect(200);
  expect(snapshot.body.content).toBe("# Before\n");
  fs.writeFileSync(file, "External changes\n");
  await request(app)
    .post(`/api/reviews/snapshots/${before.id}/restore`)
    .send({ documentPath: file, expectedVersion: snapshot.body.currentVersion })
    .expect(409);
  expect(fs.readFileSync(file, "utf8")).toBe("External changes\n");
  const refreshed = await request(app)
    .get(`/api/reviews/snapshots/${before.id}`)
    .query({ documentPath: file });
  await request(app)
    .post(`/api/reviews/snapshots/${before.id}/restore`)
    .send({
      documentPath: file,
      expectedVersion: refreshed.body.currentVersion,
    })
    .expect(200);
  expect(fs.readFileSync(file, "utf8")).toBe("# Before\n");
});

it("serves shared drafts with revision-safe deletion and rejects invalid draft payloads", async () => {
  const draft = {
    storageKey: file,
    content: "Unsaved",
    baseContent: "# Before\n",
    baseVersion: null,
    revision: "r1",
    tabId: "browser-a",
    updatedAt: Date.now(),
  };
  await request(app)
    .put("/api/reviews/drafts")
    .send({ documentPath: file, draft })
    .expect(200);
  const response = await request(app)
    .get("/api/reviews/drafts")
    .query({ documentPath: file })
    .expect(200);
  expect(response.body.drafts[0]).toMatchObject(draft);
  await request(app)
    .delete("/api/reviews/drafts")
    .send({ documentPath: file, tabId: draft.tabId, revision: "stale" })
    .expect(200, { deleted: false });
  await request(app)
    .delete("/api/reviews/drafts")
    .send({ documentPath: file, tabId: draft.tabId, revision: draft.revision })
    .expect(200, { deleted: true });
  await request(app)
    .put("/api/reviews/drafts")
    .send({ documentPath: file, draft })
    .expect(409);
  await request(app)
    .put("/api/reviews/drafts")
    .send({ documentPath: file, draft: { content: 4 } })
    .expect(400);
});
