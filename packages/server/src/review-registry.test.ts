import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReviewRegistry,
  ReviewRegistryError,
  validateReviewRoute,
} from "./review-registry";

const temporaryDirectories: string[] = [];

function makeDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function writeProject(
  name: string,
  filename: string,
  content: string,
): { projectPath: string; documentPath: string } {
  const projectPath = makeDirectory("roughdraft-review-project-");
  fs.mkdirSync(path.join(projectPath, ".git"));
  fs.writeFileSync(
    path.join(projectPath, "package.json"),
    JSON.stringify({ name }),
  );
  const documentPath = path.join(projectPath, filename);
  fs.mkdirSync(path.dirname(documentPath), { recursive: true });
  fs.writeFileSync(documentPath, content);
  return { projectPath, documentPath };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("ReviewRegistry", () => {
  it("keeps separate routes for same-named files in different projects", () => {
    const first = writeProject("Alpha workspace", "notes/plan.md", "# Plan\n");
    const second = writeProject("Beta workspace", "notes/plan.md", "# Plan\n");
    const storePath = path.join(
      makeDirectory("roughdraft-review-state-"),
      "reviews.json",
    );
    const registry = new ReviewRegistry({ storePath });

    const firstRecord = registry.register(first.documentPath);
    const secondRecord = registry.register(second.documentPath);

    expect(firstRecord).toMatchObject({
      projectName: "Alpha workspace",
      title: "Plan",
      relativePath: "notes/plan.md",
      status: "pending",
    });
    expect(secondRecord.projectName).toBe("Beta workspace");
    expect(secondRecord.route).not.toBe(firstRecord.route);
    expect(firstRecord.documentPath).toBe(fs.realpathSync(first.documentPath));
  });

  it("adds a stable short suffix for route collisions", () => {
    const project = makeDirectory("roughdraft-review-collision-");
    fs.mkdirSync(path.join(project, ".git"));
    const firstPath = path.join(project, "first.md");
    const secondPath = path.join(project, "second.md");
    fs.writeFileSync(firstPath, "# Same review\n");
    fs.writeFileSync(secondPath, "# Same review\n");
    const storePath = path.join(
      makeDirectory("roughdraft-review-state-"),
      "reviews.json",
    );
    const registry = new ReviewRegistry(storePath);

    const first = registry.register(firstPath);
    const second = registry.register(secondPath);
    const restarted = new ReviewRegistry(storePath);

    expect(first.route).toMatch(
      /^\/roughdraft-review-collision-[a-z0-9-]+\/same-review$/,
    );
    expect(second.route).toMatch(
      /^\/roughdraft-review-collision-[a-z0-9-]+\/same-review-[a-f0-9]{6,}$/,
    );
    expect(restarted.getByRoute(second.route)).toMatchObject({
      id: second.id,
      documentPath: fs.realpathSync(secondPath),
      route: second.route,
    });
  });

  it("persists pending and completed state across registry restarts", () => {
    const fixture = writeProject("Review project", "headerless.md", "body\n");
    const storePath = path.join(
      makeDirectory("roughdraft-review-state-"),
      "reviews.json",
    );
    const registry = new ReviewRegistry({ storePath });
    const record = registry.register(fixture.documentPath);

    expect(record.title).toBe("headerless");
    registry.complete(fixture.documentPath, { type: "review.completed" });

    const restarted = new ReviewRegistry({ storePath });
    expect(restarted.list()).toEqual([
      expect.objectContaining({
        id: record.id,
        status: "completed",
        completionEvent: { type: "review.completed" },
      }),
    ]);

    const reopened = restarted.openRoute(record.route);
    expect(reopened).toMatchObject({ status: "pending", route: record.route });
    expect(
      new ReviewRegistry({ storePath }).getByRoute(record.route),
    ).toMatchObject({
      status: "pending",
    });
  });

  it("supports explicit in-memory state and ignores legacy completions", () => {
    const fixture = writeProject("Memory project", "plan.md", "# Plan\n");
    const registry = new ReviewRegistry({ memory: true });
    const record = registry.register(fixture.documentPath);

    expect(registry.storePath).toBeNull();
    expect(
      registry.complete(fixture.documentPath, { type: "review.completed" }),
    ).toMatchObject({
      id: record.id,
      status: "completed",
    });

    const other = writeProject("Legacy project", "legacy.md", "# Legacy\n");
    expect(
      registry.complete(other.documentPath, { type: "review.completed" }),
    ).toBeNull();
  });

  it("rejects missing files, non-Markdown files, and unsafe routes", () => {
    const storePath = path.join(
      makeDirectory("roughdraft-review-state-"),
      "reviews.json",
    );
    const registry = new ReviewRegistry(storePath);
    const textFile = path.join(
      makeDirectory("roughdraft-review-files-"),
      "notes.txt",
    );
    fs.writeFileSync(textFile, "not markdown");

    expect(() => registry.register(textFile)).toThrow("Markdown file");
    expect(() =>
      registry.register(path.join(path.dirname(textFile), "missing.md")),
    ).toThrow("Markdown file not found");
    expect(() => validateReviewRoute("/../secrets")).toThrow(
      ReviewRegistryError,
    );
    expect(() => validateReviewRoute("/project/topic/extra")).toThrow(
      "exactly two",
    );
  });

  it("fsyncs the temporary store before replacing the registry", () => {
    const fixture = writeProject("Durable project", "review.md", "# Review\n");
    const storePath = path.join(
      makeDirectory("roughdraft-review-state-"),
      "reviews.json",
    );
    const order: string[] = [];
    const originalFsync = fs.fsyncSync;
    const originalRename = fs.renameSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      order.push("fsync");
      return originalFsync(descriptor);
    });
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      order.push("rename");
      return originalRename(from, to);
    });

    new ReviewRegistry(storePath).register(fixture.documentPath);

    expect(order).toEqual(["fsync", "rename"]);
  });

  it("fails closed when initial persistence fails", () => {
    const fixture = writeProject("Failed project", "review.md", "# Review\n");
    const storePath = path.join(
      makeDirectory("roughdraft-review-state-"),
      "reviews.json",
    );
    const registry = new ReviewRegistry(storePath);
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw new Error("disk full");
    });

    expect(() => registry.register(fixture.documentPath)).toThrow("disk full");
    expect(registry.list()).toEqual([]);
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it("rolls back a completion when persistence fails", () => {
    const fixture = writeProject("Rollback project", "review.md", "# Review\n");
    const storePath = path.join(
      makeDirectory("roughdraft-review-state-"),
      "reviews.json",
    );
    const registry = new ReviewRegistry(storePath);
    const registered = registry.register(fixture.documentPath);
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw new Error("read-only state");
    });

    expect(() =>
      registry.complete(fixture.documentPath, { type: "review.completed" }),
    ).toThrow("read-only state");
    expect(registry.getByRoute(registered.route)).toMatchObject({
      id: registered.id,
      status: "pending",
    });
    expect(registry.getByRoute(registered.route)).not.toHaveProperty(
      "completedAt",
    );
    expect(registry.getByRoute(registered.route)).not.toHaveProperty(
      "completionEvent",
    );
    expect(
      new ReviewRegistry(storePath).getByRoute(registered.route),
    ).toMatchObject({ status: "pending" });
  });
});
