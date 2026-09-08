import { describe, expect, it } from "vitest";
import { createSerializedSaveQueue } from "./serialized-saving";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("serialized document saving", () => {
  it("waits for an older in-flight save before sending newer content", async () => {
    const firstSave = deferred();
    const calls: string[] = [];
    const queue = createSerializedSaveQueue({
      save: async (content) => {
        calls.push(`start:${content}`);
        if (content === "older") await firstSave.promise;
        calls.push(`finish:${content}`);
      },
    });

    const older = queue.enqueue("older");
    const newer = queue.enqueue("newer");

    await Promise.resolve();
    expect(calls).toEqual(["start:older"]);

    firstSave.resolve();
    await expect(older).resolves.toEqual({ status: "saved" });
    await expect(newer).resolves.toEqual({ status: "saved" });
    expect(calls).toEqual([
      "start:older",
      "finish:older",
      "start:newer",
      "finish:newer",
    ]);
  });

  it("settles every superseded caller while saving only the newest queued content", async () => {
    const firstSave = deferred();
    const calls: string[] = [];
    const queue = createSerializedSaveQueue({
      save: async (content) => {
        calls.push(content);
        if (content === "first") await firstSave.promise;
      },
    });

    const first = queue.enqueue("first");
    const second = queue.enqueue("second");
    const third = queue.enqueue("third");

    await expect(second).resolves.toEqual({ status: "superseded" });
    firstSave.resolve();

    await expect(first).resolves.toEqual({ status: "saved" });
    await expect(third).resolves.toEqual({ status: "saved" });
    expect(calls).toEqual(["first", "third"]);
  });

  it("settles a queued caller as blocked when the queue is reset", async () => {
    const firstSave = deferred();
    const queue = createSerializedSaveQueue({
      save: async (content) => {
        if (content === "first") await firstSave.promise;
      },
    });

    const first = queue.enqueue("first");
    const queued = queue.enqueue("queued");
    queue.reset();

    await expect(queued).resolves.toEqual({ status: "blocked" });
    firstSave.resolve();
    await expect(first).resolves.toEqual({ status: "saved" });
  });

  it("retries the latest pending content after a transport failure", async () => {
    let shouldFail = true;
    const calls: string[] = [];
    const queue = createSerializedSaveQueue({
      save: async (content) => {
        calls.push(content);
        if (shouldFail) throw new Error("offline");
      },
    });

    await expect(queue.enqueue("first")).resolves.toMatchObject({
      status: "error",
    });
    shouldFail = false;

    await expect(queue.retryLatest("newer")).resolves.toEqual({
      status: "saved",
    });
    expect(calls).toEqual(["first", "newer"]);
  });

  it("does not retry after a conflict until the caller resets the queue", async () => {
    const calls: string[] = [];
    const queue = createSerializedSaveQueue({
      save: async (content) => {
        calls.push(content);
        throw Object.assign(new Error("conflict"), {
          name: "MarkdownFileConflictError",
        });
      },
      isConflict: (error) =>
        error instanceof Error && error.name === "MarkdownFileConflictError",
    });

    await expect(queue.enqueue("local")).resolves.toMatchObject({
      status: "error",
    });
    await expect(queue.retryLatest("local")).resolves.toEqual({
      status: "blocked",
    });
    expect(calls).toEqual(["local"]);

    queue.reset();
    await expect(queue.enqueue("after-resolution")).resolves.toMatchObject({
      status: "error",
    });
  });
});
