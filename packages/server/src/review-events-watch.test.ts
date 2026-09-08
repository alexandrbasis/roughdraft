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
      url: new URL("http://localhost/api/review-events/watch"),
    });

    await expect(waiting).resolves.toMatchObject({ timedOut: false });
    expect(pollCount).toBe(2);
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
