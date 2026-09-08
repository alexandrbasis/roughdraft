import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewRegistry } from "./review-registry";
import { installReviewRoutes } from "./review-routes";

const temporaryDirectories: string[] = [];

function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "roughdraft-review-routes-"),
  );
  temporaryDirectories.push(directory);
  fs.mkdirSync(path.join(directory, ".git"));
  const documentPath = path.join(directory, "plan.md");
  fs.writeFileSync(documentPath, "# Shipping plan\n");
  return { directory, documentPath };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("installReviewRoutes", () => {
  it("registers, resolves, lists watcher counts, and reopens a review as pending", async () => {
    const { documentPath } = fixture();
    const stateDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "roughdraft-review-state-"),
    );
    temporaryDirectories.push(stateDirectory);
    const storePath = path.join(stateDirectory, "reviews.json");
    const app = express();
    app.use(express.json());
    const registry = new ReviewRegistry(storePath);
    installReviewRoutes(
      app,
      registry,
      (pathToWatch) => (pathToWatch === fs.realpathSync(documentPath) ? 3 : 0),
      () => 8,
    );

    const registered = await request(app).post("/api/reviews").send({
      documentPath,
    });
    expect(registered.status).toBe(201);
    expect(registered.body).toMatchObject({
      title: "Shipping plan",
      status: "pending",
      waiting: true,
      reviewed: false,
      watcherCount: 3,
      afterSequence: 8,
    });

    const route = registered.body.route as string;
    const resolved = await request(app)
      .get("/api/reviews/resolve")
      .query({ route });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({
      route,
      documentPath: fs.realpathSync(documentPath),
      projectPath: fs.realpathSync(path.dirname(documentPath)),
      relativePath: "plan.md",
      status: "pending",
      watcherCount: 3,
    });
    expect(resolved.body.afterSequence).toBeUndefined();

    registry.complete(documentPath, { type: "review.completed" });
    const completed = await request(app).get("/api/reviews");
    expect(completed.status).toBe(200);
    expect(completed.body).toEqual([
      expect.objectContaining({
        route,
        status: "completed",
        waiting: false,
        reviewed: true,
        watcherCount: 3,
      }),
    ]);

    const viewed = await request(app)
      .get("/api/reviews/resolve")
      .query({ route });
    expect(viewed.status).toBe(200);
    expect(viewed.body.status).toBe("completed");

    const reopened = await request(app).post("/api/reviews").send({
      documentPath,
    });
    expect(reopened.status).toBe(201);
    expect(reopened.body.status).toBe("pending");
  });

  it("does not resolve arbitrary slugs to filesystem paths", async () => {
    const stateDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "roughdraft-review-state-"),
    );
    temporaryDirectories.push(stateDirectory);
    const app = express();
    app.use(express.json());
    installReviewRoutes(
      app,
      new ReviewRegistry(path.join(stateDirectory, "reviews.json")),
    );

    const traversal = await request(app)
      .get("/api/reviews/resolve")
      .query({ route: "/../../etc/passwd" });
    expect(traversal.status).toBe(400);
    expect(traversal.body.code).toBe("INVALID_ROUTE");

    const unknown = await request(app)
      .get("/api/reviews/resolve")
      .query({ route: "/known/unknown" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("REVIEW_NOT_FOUND");
  });
});
