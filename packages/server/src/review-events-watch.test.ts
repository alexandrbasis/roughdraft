import { describe, expect, it, vi } from "vitest";
import {
  REVIEW_WATCH_POLL_SECONDS,
  waitForReviewEvents,
} from "./review-events-watch";

describe("waitForReviewEvents", () => {
  it("keeps one explicit timeout as the overall deadline across bounded polls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const requestBodies: Array<Record<string, unknown>> = [];
    let pollCount = 0;

    const waiting = waitForReviewEvents({
      fetchImpl: async (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body ?? "{}")));
        pollCount += 1;
        if (pollCount === 1) {
          await vi.advanceTimersByTimeAsync(REVIEW_WATCH_POLL_SECONDS * 1_000);
        } else {
          await vi.advanceTimersByTimeAsync(61_000);
        }
        return new Response(
          JSON.stringify({ events: [], timedOut: true, nextSequence: 1 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
      request: {
        projectPath: "/tmp/project",
        path: "draft.md",
        batchWindowSeconds: 0,
      },
      fromNow: false,
      timeoutSeconds: 301,
      url: new URL("http://localhost/api/review-events/watch"),
    });

    await expect(waiting).resolves.toMatchObject({
      events: [],
      timedOut: true,
    });
    expect(requestBodies).toEqual([
      expect.objectContaining({
        fromNow: false,
        timeoutSeconds: REVIEW_WATCH_POLL_SECONDS,
      }),
      expect.objectContaining({
        afterSequence: 0,
        fromNow: false,
        timeoutSeconds: 61,
      }),
    ]);
    vi.useRealTimers();
  });

  it("retries a self-imposed TimeoutError before the overall deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let pollCount = 0;
    const onTransportFailure = vi.fn();

    const waiting = waitForReviewEvents({
      fetchImpl: async () => {
        pollCount += 1;
        if (pollCount === 1) {
          const error = new Error("The operation timed out");
          error.name = "TimeoutError";
          throw error;
        }
        return new Response(
          JSON.stringify({
            events: [{ type: "review.completed" }],
            timedOut: false,
            nextSequence: 2,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
      request: {
        projectPath: "/tmp/project",
        path: "draft.md",
        batchWindowSeconds: 0,
      },
      sleepImpl: async (ms) => {
        await vi.advanceTimersByTimeAsync(ms);
      },
      onTransportFailure,
      url: new URL("http://localhost/api/review-events/watch"),
    });

    await expect(waiting).resolves.toMatchObject({ timedOut: false });
    expect(pollCount).toBe(2);
    expect(onTransportFailure).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("reconnects after a dropped long-poll socket and preserves the cursor", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let pollCount = 0;

    const waiting = waitForReviewEvents({
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        requestBodies.push(body);
        pollCount += 1;

        if (pollCount === 1) {
          return new Response(
            JSON.stringify({ events: [], timedOut: true, nextSequence: 8 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (pollCount === 2) {
          const error = new TypeError("fetch failed") as TypeError & {
            cause?: { code?: string };
          };
          error.cause = { code: "UND_ERR_SOCKET" };
          throw error;
        }

        return new Response(
          JSON.stringify({
            events: [{ type: "review.completed", sequence: 8 }],
            timedOut: false,
            nextSequence: 9,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
      request: {
        projectPath: "/tmp/project",
        path: "draft.md",
        batchWindowSeconds: 0,
      },
      sleepImpl: async () => {},
      url: new URL("http://localhost/api/review-events/watch"),
      timeoutSeconds: 2,
    });

    await expect(waiting).resolves.toMatchObject({ timedOut: false });
    expect(requestBodies).toHaveLength(3);
    expect(requestBodies[1]).toMatchObject({
      afterSequence: 7,
      fromNow: false,
    });
    expect(requestBodies[2]).toMatchObject({
      afterSequence: 7,
      fromNow: false,
    });
  });

  it("starts from a caller cursor so an event before browser startup is not skipped", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];

    const waiting = waitForReviewEvents({
      fetchImpl: async (_input, init) => {
        requestBodies.push(
          JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        );
        return new Response(
          JSON.stringify({
            events: [{ type: "review.completed", sequence: 8 }],
            timedOut: false,
            nextSequence: 9,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
      request: {
        projectPath: "/tmp/project",
        path: "draft.md",
        batchWindowSeconds: 0,
      },
      afterSequence: 7,
      url: new URL("http://localhost/api/review-events/watch"),
    });

    await expect(waiting).resolves.toMatchObject({ timedOut: false });
    expect(requestBodies).toEqual([
      expect.objectContaining({
        afterSequence: 7,
        fromNow: false,
      }),
    ]);
  });

  it("returns a timeout when a retryable outage reaches the explicit deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let attempts = 0;
    const failure = new TypeError("fetch failed") as TypeError & {
      cause?: { code?: string };
    };
    failure.cause = { code: "UND_ERR_SOCKET" };

    const waiting = waitForReviewEvents({
      fetchImpl: async () => {
        attempts += 1;
        throw failure;
      },
      request: {
        projectPath: "/tmp/project",
        path: "draft.md",
        batchWindowSeconds: 0,
      },
      sleepImpl: async (ms) => {
        vi.setSystemTime(Date.now() + ms);
      },
      timeoutSeconds: 0.05,
      url: new URL("http://localhost/api/review-events/watch"),
    });

    await expect(waiting).resolves.toMatchObject({
      events: [],
      timedOut: true,
    });
    expect(attempts).toBe(1);
    vi.useRealTimers();
  });

  it("keeps retrying through a long outage until the transport recovers", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const failure = new TypeError("fetch failed") as TypeError & {
      cause?: { code?: string };
    };
    failure.cause = { code: "UND_ERR_SOCKET" };

    const waiting = waitForReviewEvents({
      fetchImpl: async () => {
        attempts += 1;
        if (attempts <= 7) throw failure;
        return new Response(
          JSON.stringify({
            events: [{ type: "review.completed", sequence: 1 }],
            timedOut: false,
            nextSequence: 2,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
      request: {
        projectPath: "/tmp/project",
        path: "draft.md",
        batchWindowSeconds: 0,
      },
      sleepImpl: async (ms) => {
        delays.push(ms);
      },
      url: new URL("http://localhost/api/review-events/watch"),
    });

    await expect(waiting).resolves.toMatchObject({ timedOut: false });
    expect(attempts).toBe(8);
    expect(delays).toEqual([100, 200, 400, 800, 1_600, 3_200, 5_000]);
  });

  it("lets the caller recover a dead daemon without resetting the cursor", async () => {
    const requestUrls: string[] = [];
    const failures: Array<{
      attempt: number;
      error: unknown;
      url: URL;
    }> = [];
    let attempts = 0;
    const failure = new TypeError("fetch failed") as TypeError & {
      cause?: { code?: string };
    };
    failure.cause = { code: "ECONNREFUSED" };

    const waiting = waitForReviewEvents({
      fetchImpl: async (input) => {
        requestUrls.push(String(input));
        attempts += 1;
        if (attempts === 1) {
          return new Response(
            JSON.stringify({ events: [], timedOut: true, nextSequence: 8 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (attempts === 2) throw failure;
        return new Response(
          JSON.stringify({
            events: [{ type: "review.completed", sequence: 8 }],
            timedOut: false,
            nextSequence: 9,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
      request: {
        projectPath: "/tmp/project",
        path: "draft.md",
        batchWindowSeconds: 0,
      },
      sleepImpl: async () => {},
      onTransportFailure: async (failureContext) => {
        failures.push(failureContext);
        return new URL("http://restarted/api/review-events/watch");
      },
      url: new URL("http://old/api/review-events/watch"),
    });

    await expect(waiting).resolves.toMatchObject({ timedOut: false });
    expect(requestUrls).toEqual([
      "http://old/api/review-events/watch",
      "http://old/api/review-events/watch",
      "http://restarted/api/review-events/watch",
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      attempt: 1,
      error: failure,
      url: new URL("http://old/api/review-events/watch"),
    });
  });

  it("does not route HTTP validation failures through transport recovery", async () => {
    const onTransportFailure = vi.fn();

    const waiting = waitForReviewEvents({
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "invalid request" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      request: {
        projectPath: "/tmp/project",
        path: "draft.md",
        batchWindowSeconds: 0,
      },
      onTransportFailure,
      url: new URL("http://localhost/api/review-events/watch"),
    });

    await expect(waiting).rejects.toThrow("Review watch failed: 400");
    expect(onTransportFailure).not.toHaveBeenCalled();
  });

  it("clips retry delay to the remaining explicit deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const delays: number[] = [];
    const failure = new TypeError("fetch failed") as TypeError & {
      cause?: { code?: string };
    };
    failure.cause = { code: "UND_ERR_SOCKET" };

    const waiting = waitForReviewEvents({
      fetchImpl: async () => {
        throw failure;
      },
      request: {
        projectPath: "/tmp/project",
        path: "draft.md",
        batchWindowSeconds: 0,
      },
      sleepImpl: async (ms) => {
        delays.push(ms);
        vi.setSystemTime(Date.now() + ms);
      },
      timeoutSeconds: 0.05,
      url: new URL("http://localhost/api/review-events/watch"),
    });

    await expect(waiting).resolves.toMatchObject({
      events: [],
      timedOut: true,
    });
    expect(delays).toEqual([50]);
    vi.useRealTimers();
  });

  it("bounds the final transport signal by the explicit deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const waiting = waitForReviewEvents({
      fetchImpl: (_input, init) =>
        new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason);
          });
        }),
      request: {
        projectPath: "/tmp/project",
        path: "draft.md",
        batchWindowSeconds: 0,
      },
      timeoutSeconds: 2,
      url: new URL("http://localhost/api/review-events/watch"),
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(
      await Promise.race([
        waiting.then(() => "done"),
        Promise.resolve("pending"),
      ]),
    ).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toMatchObject({
      events: [],
      timedOut: true,
    });
    vi.useRealTimers();
  });
});
