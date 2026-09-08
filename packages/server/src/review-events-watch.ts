import { setTimeout as sleep } from "node:timers/promises";

export const REVIEW_WATCH_POLL_SECONDS = 240;

const REVIEW_WATCH_RESPONSE_GRACE_MS = 5_000;
const REVIEW_WATCH_RETRY_DELAY_MS = 100;

export interface ReviewWatchRequest {
  projectPath: string;
  path: string;
  batchWindowSeconds: number;
}

export interface ReviewWatchPayload {
  events?: unknown[];
  timedOut?: boolean;
  nextSequence?: number;
  [key: string]: unknown;
}

export interface ReviewWatchOptions {
  fetchImpl: typeof fetch;
  request: ReviewWatchRequest;
  url: URL;
  fromNow?: boolean;
  timeoutSeconds?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Wait for a review event without keeping one HTTP response open longer than
 * the default fetch headers timeout. The timeout, when supplied, is the total
 * watch deadline rather than a per-poll timeout.
 */
export async function waitForReviewEvents(
  options: ReviewWatchOptions,
): Promise<ReviewWatchPayload> {
  const timeoutMs =
    options.timeoutSeconds === undefined
      ? undefined
      : Math.max(0, options.timeoutSeconds * 1_000);
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  const sleepImpl = options.sleepImpl ?? ((ms: number) => sleep(ms));

  let fromNow = options.fromNow ?? true;
  let needsCursorAnchor = fromNow;
  let afterSequence: number | undefined;
  let firstLongPoll = true;

  while (true) {
    const remainingMs =
      deadline === undefined ? Number.POSITIVE_INFINITY : deadline - Date.now();
    if (remainingMs <= 0) {
      return timeoutPayload(afterSequence);
    }

    const anchorPoll = needsCursorAnchor;
    const pollMs = anchorPoll
      ? 0
      : Math.min(REVIEW_WATCH_POLL_SECONDS * 1_000, remainingMs);
    const finalPoll =
      !anchorPoll && deadline !== undefined && pollMs >= remainingMs;
    const requestTimeoutSeconds = anchorPoll
      ? 0
      : firstLongPoll && timeoutMs !== undefined
        ? Math.min(REVIEW_WATCH_POLL_SECONDS * 1_000, timeoutMs) / 1_000
        : pollMs / 1_000;

    if (!anchorPoll) {
      firstLongPoll = false;
    }

    const body: Record<string, unknown> = {
      ...options.request,
      fromNow,
      timeoutSeconds: requestTimeoutSeconds,
    };
    if (afterSequence !== undefined) {
      body.afterSequence = afterSequence;
    }

    let payload: ReviewWatchPayload;
    try {
      const response = await options.fetchImpl(options.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(
          deadline === undefined
            ? Math.max(1, pollMs + REVIEW_WATCH_RESPONSE_GRACE_MS)
            : Math.max(
                1,
                Math.min(pollMs + REVIEW_WATCH_RESPONSE_GRACE_MS, remainingMs),
              ),
        ),
      });

      if (!response.ok) {
        throw new Error(`Review watch failed: ${response.status}`);
      }

      payload = (await response.json()) as ReviewWatchPayload;
    } catch (error) {
      if (!isRetryableWatchError(error)) {
        throw error;
      }

      if (deadline !== undefined && Date.now() >= deadline) {
        return timeoutPayload(afterSequence);
      }

      await sleepImpl(REVIEW_WATCH_RETRY_DELAY_MS);
      continue;
    }

    const nextSequence = sequenceFromPayload(payload);
    if (nextSequence !== undefined) {
      // The server returns the next unassigned sequence, while the watch API
      // expects the last sequence already seen.
      afterSequence = Math.max(afterSequence ?? 0, nextSequence - 1);
      fromNow = false;
    }
    needsCursorAnchor = false;

    if (Array.isArray(payload.events) && payload.events.length > 0) {
      return payload;
    }

    if (payload.timedOut && finalPoll) {
      return payload;
    }

    if (deadline !== undefined && Date.now() >= deadline) {
      return { ...payload, events: [], timedOut: true };
    }
  }
}

function sequenceFromPayload(payload: ReviewWatchPayload): number | undefined {
  if (
    typeof payload.nextSequence !== "number" ||
    !Number.isFinite(payload.nextSequence) ||
    payload.nextSequence < 1
  ) {
    return undefined;
  }

  return Math.floor(payload.nextSequence);
}

function timeoutPayload(afterSequence: number | undefined): ReviewWatchPayload {
  return {
    events: [],
    timedOut: true,
    ...(afterSequence === undefined ? {} : { nextSequence: afterSequence + 1 }),
  };
}

function isRetryableWatchError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const candidate = error as {
    cause?: unknown;
    code?: unknown;
    name?: unknown;
  };
  if (candidate.name === "AbortError" || candidate.name === "TimeoutError") {
    return true;
  }
  if (
    candidate.code === "UND_ERR_HEADERS_TIMEOUT" ||
    candidate.code === "UND_ERR_BODY_TIMEOUT"
  ) {
    return true;
  }

  return isRetryableWatchError(candidate.cause);
}
