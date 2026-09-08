import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface ReviewCompletedEventInput {
  documentPath: string;
  projectPath: string;
  relativePath: string;
  version: string;
  summary: {
    comments: number;
    replies: number;
    suggestions: number;
    unresolved: number;
  };
  overallComment?: string;
}

export interface ReviewCompletedEvent extends ReviewCompletedEventInput {
  roundId?: string;
  type: "review.completed";
  sequence: number;
  createdAt: string;
}

export interface WaitForReviewEventsOptions {
  documentPath?: string;
  afterSequence?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  batchWindowMs?: number;
}

export interface WaitForReviewEventsResult {
  events: ReviewCompletedEvent[];
  timedOut: boolean;
  nextSequence: number;
}

interface ReviewEventJournal {
  version: 1;
  nextSequence: number;
  events: ReviewCompletedEvent[];
}

export interface ReviewEventPersistence {
  loadEvents(): { events: ReviewCompletedEvent[]; nextSequence: number };
  appendEvent(event: ReviewCompletedEvent, writeId?: string): void;
}

interface Waiter {
  options: NormalizedWaitOptions;
  resolve: (result: WaitForReviewEventsResult) => void;
  abortListener: (() => void) | null;
  signal?: AbortSignal;
  timeout: NodeJS.Timeout | null;
  batchTimeout: NodeJS.Timeout | null;
}

const DEFAULT_BATCH_WINDOW_MS = 250;
const MAX_RETAINED_EVENTS = 100;

type NormalizedWaitOptions = Required<
  Omit<WaitForReviewEventsOptions, "documentPath" | "signal" | "timeoutMs">
> & {
  documentPath?: string;
  timeoutMs?: number;
};

export class ReviewEventQueue {
  private events: ReviewCompletedEvent[] = [];
  private waiters = new Set<Waiter>();
  private nextSequence = 1;
  private readonly journalPath?: string;
  private readonly persistence?: ReviewEventPersistence;

  constructor(journalPath?: string | ReviewEventPersistence) {
    if (journalPath === undefined) return;

    if (typeof journalPath !== "string") {
      this.persistence = journalPath;
      const state = journalPath.loadEvents();
      this.events = state.events;
      this.nextSequence = state.nextSequence;
      return;
    }

    if (journalPath.trim().length === 0) {
      throw new Error("Review event journal path must not be empty.");
    }

    this.journalPath = path.resolve(journalPath);
    const state = loadJournal(this.journalPath);
    this.events = state.events;
    this.nextSequence = state.nextSequence;
  }

  emit(
    input: ReviewCompletedEventInput,
    writeId?: string,
  ): {
    delivered: boolean;
    event: ReviewCompletedEvent;
  } {
    if (this.nextSequence === Number.MAX_SAFE_INTEGER) {
      throw new Error("Review event sequence space is exhausted.");
    }

    const event: ReviewCompletedEvent = {
      ...input,
      type: "review.completed",
      sequence: this.nextSequence,
      createdAt: new Date().toISOString(),
    };
    const nextEvents =
      this.journalPath || this.persistence
        ? [...this.events, event]
        : retainEvents([...this.events, event], event.projectPath);
    const nextSequence = this.nextSequence + 1;

    this.persistence?.appendEvent(event, writeId);

    if (this.journalPath) {
      persistJournal(this.journalPath, {
        version: 1,
        nextSequence,
        events: nextEvents,
      });
    }

    this.nextSequence = nextSequence;
    this.events = nextEvents;

    appendSlog("review-events.emit", {
      documentPath: event.documentPath,
      sequence: event.sequence,
      waiters: this.waiters.size,
      hasOverallComment: typeof event.overallComment === "string",
      overallCommentLength: event.overallComment?.length ?? 0,
    });

    let delivered = false;
    for (const waiter of [...this.waiters]) {
      if (matchesWaiter(event, waiter.options)) {
        delivered = true;
        this.scheduleResolve(waiter);
      }
    }

    return { delivered, event };
  }

  wait(
    options: WaitForReviewEventsOptions = {},
  ): Promise<WaitForReviewEventsResult> {
    const normalized = normalizeWaitOptions(options);
    const existing = this.matchingEvents(normalized);

    if (options.signal?.aborted) {
      return Promise.resolve(resultForEvents([], true, this.nextSequence));
    }

    if (existing.length > 0) {
      return Promise.resolve(
        resultForEvents(existing, false, this.nextSequence),
      );
    }

    return new Promise((resolve) => {
      const waiter: Waiter = {
        options: normalized,
        resolve,
        abortListener: null,
        signal: options.signal,
        batchTimeout: null,
        timeout:
          normalized.timeoutMs !== undefined
            ? setTimeout(() => {
                this.resolveWaiter(waiter, true);
              }, normalized.timeoutMs)
            : null,
      };

      this.waiters.add(waiter);

      if (options.signal) {
        waiter.abortListener = () => this.resolveWaiter(waiter, true);
        options.signal.addEventListener("abort", waiter.abortListener, {
          once: true,
        });
      }

      if (options.signal?.aborted) {
        this.resolveWaiter(waiter, true);
        return;
      }

      appendSlog("review-events.wait", {
        documentPath: normalized.documentPath ?? null,
        afterSequence: normalized.afterSequence,
        timeoutMs: normalized.timeoutMs,
      });
    });
  }

  waiterCount(): number {
    return this.waiters.size;
  }

  latestSequence(): number {
    return this.nextSequence - 1;
  }

  snapshot(): ReviewCompletedEvent[] {
    return this.events.map(cloneReviewEvent);
  }

  latestEventForDocument(
    documentPath: string,
  ): ReviewCompletedEvent | undefined {
    const normalizedPath = canonicalPath(documentPath);
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (event && canonicalPath(event.documentPath) === normalizedPath) {
        return cloneReviewEvent(event);
      }
    }
    return undefined;
  }

  waiterCountForDocument(documentPath: string): number {
    const normalizedPath = canonicalPath(documentPath);
    return [...this.waiters].filter(
      (waiter) => waiter.options.documentPath === normalizedPath,
    ).length;
  }

  private matchingEvents(
    options: NormalizedWaitOptions,
  ): ReviewCompletedEvent[] {
    return this.events.filter((event) => matchesWaiter(event, options));
  }

  private scheduleResolve(waiter: Waiter): void {
    if (waiter.batchTimeout) return;

    if (waiter.timeout) {
      clearTimeout(waiter.timeout);
      waiter.timeout = null;
    }

    waiter.batchTimeout = setTimeout(() => {
      this.resolveWaiter(waiter, false);
    }, waiter.options.batchWindowMs);
  }

  private resolveWaiter(waiter: Waiter, timedOut: boolean): void {
    if (!this.waiters.has(waiter)) return;

    this.waiters.delete(waiter);
    if (waiter.timeout) {
      clearTimeout(waiter.timeout);
    }
    if (waiter.batchTimeout) {
      clearTimeout(waiter.batchTimeout);
    }
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
      waiter.abortListener = null;
    }

    const events = timedOut ? [] : this.matchingEvents(waiter.options);
    waiter.resolve(resultForEvents(events, timedOut, this.nextSequence));
  }
}

function retainEvents(
  events: ReviewCompletedEvent[],
  projectPath: string,
): ReviewCompletedEvent[] {
  const normalizedProjectPath = canonicalPath(projectPath);
  const projectEvents = events.filter(
    (event) => canonicalPath(event.projectPath) === normalizedProjectPath,
  );
  const otherProjectEvents = events.filter(
    (event) => canonicalPath(event.projectPath) !== normalizedProjectPath,
  );

  return [
    ...otherProjectEvents,
    ...projectEvents.slice(-MAX_RETAINED_EVENTS),
  ].sort((left, right) => left.sequence - right.sequence);
}

function loadJournal(journalPath: string): ReviewEventJournal {
  let serialized: string;
  try {
    serialized = fs.readFileSync(journalPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { version: 1, nextSequence: 1, events: [] };
    }
    throw journalError(journalPath, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw journalError(journalPath, error, "contains invalid JSON");
  }

  try {
    return validateJournal(parsed);
  } catch (error) {
    throw journalError(
      journalPath,
      error,
      error instanceof Error ? error.message : "contains invalid data",
    );
  }
}

function persistJournal(
  journalPath: string,
  journal: ReviewEventJournal,
): void {
  const directory = path.dirname(journalPath);
  const temporaryPath = `${journalPath}.${process.pid}.${randomUUID()}.tmp`;
  let fileDescriptor: number | undefined;

  try {
    fs.mkdirSync(directory, { recursive: true });
    fileDescriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(fileDescriptor, `${JSON.stringify(journal)}\n`, "utf8");
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fs.renameSync(temporaryPath, journalPath);
    syncDirectory(directory);
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        fs.closeSync(fileDescriptor);
      } catch {
        // Preserve the persistence error as the actionable failure.
      }
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The rename may already have completed, or cleanup may be impossible.
    }
    throw journalError(journalPath, error, "could not be persisted atomically");
  }
}

function syncDirectory(directory: string): void {
  const fileDescriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fileDescriptor);
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

function validateJournal(value: unknown): ReviewEventJournal {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("journal version is unsupported");
  }
  if (!isSafePositiveInteger(value.nextSequence)) {
    throw new Error("nextSequence must be a positive integer");
  }
  if (!Array.isArray(value.events)) {
    throw new Error("events must be an array");
  }

  const events = value.events.map((event, index) =>
    validateEvent(event, index),
  );
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];
    if (!previous || !current || current.sequence <= previous.sequence) {
      throw new Error("events must be ordered by unique sequence");
    }
  }
  const lastSequence = events.at(-1)?.sequence ?? 0;
  if (value.nextSequence <= lastSequence) {
    throw new Error("nextSequence must be greater than every event sequence");
  }

  return { version: 1, nextSequence: value.nextSequence, events };
}

function validateEvent(value: unknown, index: number): ReviewCompletedEvent {
  if (!isRecord(value) || value.type !== "review.completed") {
    throw new Error(`event ${index} has an invalid type`);
  }
  if (
    !isNonEmptyString(value.documentPath) ||
    !isNonEmptyString(value.projectPath) ||
    !isNonEmptyString(value.relativePath) ||
    !isNonEmptyString(value.version) ||
    !isNonEmptyString(value.createdAt) ||
    !isSafePositiveInteger(value.sequence)
  ) {
    throw new Error(`event ${index} has invalid identity or sequence data`);
  }
  if (Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error(`event ${index} has an invalid createdAt timestamp`);
  }
  if (!isRecord(value.summary)) {
    throw new Error(`event ${index} has an invalid summary`);
  }
  for (const key of ["comments", "replies", "suggestions", "unresolved"]) {
    if (!isNonNegativeInteger(value.summary[key])) {
      throw new Error(`event ${index} has an invalid ${key} count`);
    }
  }
  if (
    Object.hasOwn(value, "overallComment") &&
    value.overallComment !== undefined &&
    typeof value.overallComment !== "string"
  ) {
    throw new Error(`event ${index} has an invalid overallComment`);
  }

  return value as unknown as ReviewCompletedEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  );
}

function journalError(
  journalPath: string,
  error: unknown,
  detail?: string,
): Error {
  const reason =
    detail ?? (error instanceof Error ? error.message : String(error));
  return new Error(`Review event journal ${journalPath} ${reason}`, {
    cause: error,
  });
}

function normalizeWaitOptions(
  options: WaitForReviewEventsOptions,
): NormalizedWaitOptions {
  return {
    documentPath: options.documentPath
      ? canonicalPath(options.documentPath)
      : undefined,
    afterSequence: Math.max(0, options.afterSequence ?? 0),
    timeoutMs:
      options.timeoutMs !== undefined
        ? normalizeTimeoutMs(options.timeoutMs)
        : undefined,
    batchWindowMs: clamp(
      options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS,
      0,
      10_000,
    ),
  };
}

function matchesWaiter(
  event: ReviewCompletedEvent,
  options: NormalizedWaitOptions,
): boolean {
  if (event.sequence <= options.afterSequence) return false;
  if (!options.documentPath) return true;
  return canonicalPath(event.documentPath) === options.documentPath;
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);

  try {
    return fs.realpathSync.native(resolved);
  } catch {
    const unresolvedSegments: string[] = [];
    let existingPath = resolved;

    while (true) {
      try {
        const canonicalExistingPath = fs.realpathSync.native(existingPath);
        return path.join(canonicalExistingPath, ...unresolvedSegments);
      } catch {
        const parentPath = path.dirname(existingPath);
        if (parentPath === existingPath) return resolved;
        unresolvedSegments.unshift(path.basename(existingPath));
        existingPath = parentPath;
      }
    }
  }
}

function resultForEvents(
  events: ReviewCompletedEvent[],
  timedOut: boolean,
  nextSequence: number,
): WaitForReviewEventsResult {
  return {
    events,
    timedOut,
    nextSequence,
  };
}

function cloneReviewEvent(event: ReviewCompletedEvent): ReviewCompletedEvent {
  return {
    ...event,
    summary: { ...event.summary },
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function normalizeTimeoutMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(2_147_483_647, Math.max(0, value));
}

function appendSlog(event: string, data: Record<string, unknown>): void {
  const file = process.env.THOUGHTFUL_SLOG_FILE;
  if (!file) return;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      runId: process.env.THOUGHTFUL_SLOG_RUN_ID ?? "manual",
      source: "packages/server/src/review-events.ts",
      event,
      data,
    })}\n`,
  );
}
