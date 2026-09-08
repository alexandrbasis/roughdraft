import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./index";
import { ReviewEventQueue } from "./review-events";

function eventInput(documentPath = "/tmp/project/draft.md") {
  return {
    documentPath,
    projectPath: path.dirname(documentPath),
    relativePath: path.basename(documentPath),
    version: "v1",
    summary: {
      comments: 1,
      replies: 0,
      suggestions: 1,
      unresolved: 2,
    },
  };
}

describe("ReviewEventQueue", () => {
  it("queues events in creation order", async () => {
    const queue = new ReviewEventQueue();

    queue.emit(eventInput("/tmp/project/a.md"));
    queue.emit(eventInput("/tmp/project/b.md"));

    const result = await queue.wait({ timeoutMs: 0 });

    expect(result.timedOut).toBe(false);
    expect(result.events.map((event) => event.documentPath)).toEqual([
      "/tmp/project/a.md",
      "/tmp/project/b.md",
    ]);
    expect(result.events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("resolves a waiting watcher when a matching event arrives", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath: "/tmp/project/draft.md",
      timeoutMs: 1_000,
      batchWindowMs: 10,
    });

    const emitted = queue.emit(eventInput("/tmp/project/draft.md"));
    await vi.advanceTimersByTimeAsync(10);

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      events: [emitted.event],
    });
    expect(emitted.delivered).toBe(true);
    vi.useRealTimers();
  });

  it("removes an aborted watcher and does not deliver later events to it", async () => {
    const queue = new ReviewEventQueue();
    const controller = new AbortController();
    const waiting = queue.wait({
      documentPath: "/tmp/project/draft.md",
      signal: controller.signal,
      batchWindowMs: 0,
    });

    expect(queue.waiterCount()).toBe(1);
    controller.abort();

    await expect(waiting).resolves.toMatchObject({
      events: [],
      timedOut: true,
    });
    expect(queue.waiterCount()).toBe(0);
    expect(queue.emit(eventInput("/tmp/project/draft.md")).delivered).toBe(
      false,
    );
  });

  it("returns overall comments with delivered events", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath: "/tmp/project/draft.md",
      timeoutMs: 1_000,
      batchWindowMs: 0,
    });

    queue.emit({
      ...eventInput("/tmp/project/draft.md"),
      overallComment: "Please prioritize the CLI contract.",
    });
    await vi.advanceTimersByTimeAsync(0);

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      events: [
        {
          overallComment: "Please prioritize the CLI contract.",
        },
      ],
    });
    vi.useRealTimers();
  });

  it("keeps events without overall comments unchanged", async () => {
    const queue = new ReviewEventQueue();

    queue.emit(eventInput("/tmp/project/draft.md"));

    const result = await queue.wait();
    expect(result.events[0]).not.toHaveProperty("overallComment");
  });

  it("keeps a watcher active without a timeout until a matching event arrives", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath: "/tmp/project/draft.md",
      batchWindowMs: 0,
    });

    await vi.advanceTimersByTimeAsync(300_000);
    expect(queue.waiterCount()).toBe(1);

    const emitted = queue.emit(eventInput("/tmp/project/draft.md"));
    await vi.advanceTimersByTimeAsync(0);

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      events: [emitted.event],
    });
    vi.useRealTimers();
  });

  it("ignores unrelated document paths", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath: "/tmp/project/draft.md",
      timeoutMs: 100,
      batchWindowMs: 0,
    });

    const emitted = queue.emit(eventInput("/tmp/project/other.md"));
    await vi.advanceTimersByTimeAsync(100);

    await expect(waiting).resolves.toMatchObject({
      timedOut: true,
      events: [],
    });
    expect(emitted.delivered).toBe(false);
    vi.useRealTimers();
  });

  it("batches events during the batch window", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({ timeoutMs: 1_000, batchWindowMs: 50 });

    queue.emit(eventInput("/tmp/project/a.md"));
    await vi.advanceTimersByTimeAsync(25);
    queue.emit(eventInput("/tmp/project/b.md"));
    await vi.advanceTimersByTimeAsync(25);

    const result = await waiting;

    expect(result.events.map((event) => event.documentPath)).toEqual([
      "/tmp/project/a.md",
      "/tmp/project/b.md",
    ]);
    vi.useRealTimers();
  });

  it("does not time out after a matching event arrives during a longer batch window", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath: "/tmp/project/draft.md",
      timeoutMs: 100,
      batchWindowMs: 200,
    });

    await vi.advanceTimersByTimeAsync(50);
    const emitted = queue.emit(eventInput("/tmp/project/draft.md"));
    await vi.advanceTimersByTimeAsync(200);

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      events: [emitted.event],
    });
    expect(emitted.delivered).toBe(true);
    vi.useRealTimers();
  });

  it("prunes retained events deterministically", async () => {
    const queue = new ReviewEventQueue();

    for (let index = 0; index < 105; index += 1) {
      queue.emit(eventInput(`/tmp/project/${index}.md`));
    }

    const result = await queue.wait();

    expect(result.events).toHaveLength(100);
    expect(result.events[0]?.sequence).toBe(6);
    expect(result.events.at(-1)?.sequence).toBe(105);
  });

  it("reloads events from a journal and continues the sequence after restart", async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "roughdraft-review-events-journal-"),
    );
    const journalPath = path.join(tempDir, "review-events.json");
    const documentPath = path.join(tempDir, "project", "draft.md");

    try {
      const firstQueue = new ReviewEventQueue(journalPath);
      const first = firstQueue.emit(eventInput(documentPath));

      const restartedQueue = new ReviewEventQueue(journalPath);
      const recovered = await restartedQueue.wait({
        documentPath,
        afterSequence: 0,
        timeoutMs: 0,
      });
      const second = restartedQueue.emit(eventInput(documentPath));

      expect(recovered).toMatchObject({
        timedOut: false,
        events: [first.event],
      });
      expect(second.event.sequence).toBe(first.event.sequence + 1);
      expect(new ReviewEventQueue(journalPath).latestSequence()).toBe(2);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when the durable journal is corrupt", () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "roughdraft-review-events-corrupt-"),
    );
    const journalPath = path.join(tempDir, "review-events.json");

    try {
      fs.writeFileSync(journalPath, "{not valid json", "utf8");

      expect(() => new ReviewEventQueue(journalPath)).toThrow(
        /contains invalid JSON/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not acknowledge an event when the journal cannot be written", async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "roughdraft-review-events-write-failure-"),
    );
    const journalDirectory = path.join(tempDir, "journal");
    const journalPath = path.join(journalDirectory, "review-events.json");
    fs.mkdirSync(journalDirectory);
    const queue = new ReviewEventQueue(journalPath);
    fs.rmSync(journalDirectory, { recursive: true, force: true });
    fs.writeFileSync(journalDirectory, "blocking file", "utf8");

    try {
      expect(() => queue.emit(eventInput())).toThrow(
        /could not be persisted atomically/,
      );
      expect(queue.latestSequence()).toBe(0);
      await expect(queue.wait({ timeoutMs: 0 })).resolves.toMatchObject({
        timedOut: true,
        events: [],
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns durable snapshots and defensive latest document events", () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "roughdraft-review-events-snapshot-"),
    );
    const journalPath = path.join(tempDir, "review-events.json");
    const documentPath = path.join(tempDir, "project", "draft.md");

    try {
      const queue = new ReviewEventQueue(journalPath);
      const emitted = queue.emit(eventInput(documentPath));
      const snapshot = queue.snapshot();
      const latest = queue.latestEventForDocument(documentPath);

      expect(snapshot).toEqual([emitted.event]);
      expect(latest).toEqual(emitted.event);
      expect(latest).not.toBe(emitted.event);
      expect(latest?.summary).not.toBe(emitted.event.summary);

      if (latest) {
        latest.summary.comments = 99;
        latest.documentPath = path.join(tempDir, "changed.md");
      }

      expect(queue.latestEventForDocument(documentPath)).toEqual(emitted.event);
      expect(new ReviewEventQueue(journalPath).snapshot()).toEqual([
        emitted.event,
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("matches symlinked document aliases for waiting and latest-event lookup", async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "roughdraft-review-events-symlink-"),
    );
    const realProject = path.join(tempDir, "real-project");
    const aliasProject = path.join(tempDir, "alias-project");
    const realDocument = path.join(realProject, "draft.md");
    const aliasDocument = path.join(aliasProject, "draft.md");

    try {
      fs.mkdirSync(realProject, { recursive: true });
      fs.writeFileSync(realDocument, "draft", "utf8");
      fs.symlinkSync(realProject, aliasProject, "dir");

      vi.useFakeTimers();
      const queue = new ReviewEventQueue();
      const waiting = queue.wait({
        documentPath: aliasDocument,
        timeoutMs: 1_000,
        batchWindowMs: 0,
      });

      expect(queue.waiterCountForDocument(realDocument)).toBe(1);
      const emitted = queue.emit(eventInput(realDocument));
      await vi.advanceTimersByTimeAsync(0);

      await expect(waiting).resolves.toMatchObject({
        timedOut: false,
        events: [emitted.event],
      });
      expect(queue.latestEventForDocument(aliasDocument)).toEqual(
        emitted.event,
      );
    } finally {
      vi.useRealTimers();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps durable history when 100 other documents complete in the same project", async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "roughdraft-review-events-durable-retention-"),
    );
    const journalPath = path.join(tempDir, "review-events.json");
    const projectPath = path.join(tempDir, "project");
    const awaitedDocument = path.join(projectPath, "awaited.md");

    try {
      const queue = new ReviewEventQueue(journalPath);
      const awaited = queue.emit(eventInput(awaitedDocument));
      for (let index = 0; index < 100; index += 1) {
        queue.emit(eventInput(path.join(projectPath, `other-${index}.md`)));
      }

      const restartedQueue = new ReviewEventQueue(journalPath);
      const result = await restartedQueue.wait({
        documentPath: awaitedDocument,
        afterSequence: 0,
        timeoutMs: 0,
      });

      expect(result).toMatchObject({
        timedOut: false,
        events: [awaited.event],
      });
      expect(restartedQueue.snapshot()).toHaveLength(101);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not evict one project's retained history with another project's events", async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "roughdraft-review-events-retention-"),
    );
    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const queue = new ReviewEventQueue();
    const first = queue.emit(eventInput(path.join(projectA, "draft.md")));

    try {
      for (let index = 0; index < 100; index += 1) {
        queue.emit(eventInput(path.join(projectB, `${index}.md`)));
      }

      const result = await queue.wait({
        documentPath: path.join(projectA, "draft.md"),
        afterSequence: 0,
        timeoutMs: 0,
      });

      expect(result.timedOut).toBe(false);
      expect(result.events).toEqual([first.event]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("honors an explicit queue timeout beyond the old five-minute clamp", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({ timeoutMs: 300_001 });

    await vi.advanceTimersByTimeAsync(300_000);
    expect(queue.waiterCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(waiting).resolves.toMatchObject({
      timedOut: true,
      events: [],
    });
    vi.useRealTimers();
  });

  it("delivers an event emitted between network polls when the cursor uses the previous sequence", async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "roughdraft-watch-network-"),
    );
    const projectDir = path.join(tempDir, "project");
    const homeDir = path.join(tempDir, "home");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "draft.md"), "# Draft\n");
    fs.writeFileSync(path.join(projectDir, "other.md"), "# Other\n");

    const { app } = createApp({
      homeDir,
      projectDir,
      staticDirPath: projectDir,
    });
    const server: Server = createHttpServer(app);

    try {
      const port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address() as AddressInfo;
          resolve(address.port);
        });
      });
      const baseUrl = `http://127.0.0.1:${port}`;
      const request = (pathname: string, body: Record<string, unknown>) =>
        fetch(`${baseUrl}${pathname}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      await request("/api/review-events", {
        projectPath: projectDir,
        path: "other.md",
      });
      const firstResponse = await request("/api/review-events/watch", {
        projectPath: projectDir,
        path: "draft.md",
        fromNow: true,
        timeoutSeconds: 0.01,
        batchWindowSeconds: 0,
      });
      const first = (await firstResponse.json()) as {
        nextSequence: number;
        timedOut: boolean;
      };

      expect(first).toEqual({
        events: [],
        nextSequence: 2,
        timedOut: true,
      });

      const emittedResponse = await request("/api/review-events", {
        projectPath: projectDir,
        path: "draft.md",
      });
      expect(emittedResponse.status).toBe(201);

      const secondResponse = await request("/api/review-events/watch", {
        projectPath: projectDir,
        path: "draft.md",
        fromNow: false,
        afterSequence: first.nextSequence - 1,
        timeoutSeconds: 0.1,
        batchWindowSeconds: 0,
      });
      const second = (await secondResponse.json()) as {
        events: Array<{ documentPath: string; sequence: number }>;
        timedOut: boolean;
      };

      expect(second).toMatchObject({
        timedOut: false,
        events: [
          {
            documentPath: path.join(projectDir, "draft.md"),
            sequence: 2,
          },
        ],
      });
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
