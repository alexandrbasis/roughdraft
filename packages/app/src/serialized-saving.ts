export type SerializedSaveResult =
  | { status: "saved" }
  | { status: "blocked" }
  | { status: "superseded" }
  | { status: "error"; error: unknown };

interface QueuedSave {
  content: string;
  resolve: (result: SerializedSaveResult) => void;
  settled: boolean;
}

export interface SerializedSaveQueue {
  enqueue(content: string): Promise<SerializedSaveResult>;
  retryLatest(content: string): Promise<SerializedSaveResult>;
  setPaused(paused: boolean): void;
  reset(): void;
}

export function createSerializedSaveQueue({
  save,
  isConflict = (error) =>
    error instanceof Error && error.name === "MarkdownFileConflictError",
}: {
  save: (content: string) => Promise<void>;
  isConflict?: (error: unknown) => boolean;
}): SerializedSaveQueue {
  let active = false;
  let paused = false;
  let blocked = false;
  let retryableError: unknown = null;
  let queued: QueuedSave | null = null;

  const settle = (task: QueuedSave, result: SerializedSaveResult) => {
    if (task.settled) return;
    task.settled = true;
    task.resolve(result);
  };

  const drain = async (): Promise<void> => {
    if (active || paused || blocked || retryableError !== null || !queued)
      return;

    const task = queued;
    queued = null;
    active = true;

    try {
      await save(task.content);
      settle(task, { status: "saved" });
    } catch (error) {
      settle(task, { status: "error", error });

      if (isConflict(error)) {
        blocked = true;
        if (queued) {
          settle(queued, { status: "blocked" });
          queued = null;
        }
      } else {
        retryableError = error;
        if (queued) settle(queued, { status: "error", error });
      }
    } finally {
      active = false;
      if (!blocked && retryableError === null && queued) {
        void drain();
      }
    }
  };

  const makeTask = (
    content: string,
    resolve: (result: SerializedSaveResult) => void,
  ): QueuedSave => ({
    content,
    resolve,
    settled: false,
  });

  return {
    enqueue(content) {
      return new Promise<SerializedSaveResult>((resolve) => {
        const task = makeTask(content, resolve);
        if (queued) settle(queued, { status: "superseded" });
        queued = task;

        if (blocked) {
          settle(task, { status: "blocked" });
          queued = null;
          return;
        }

        if (retryableError !== null) {
          settle(task, { status: "error", error: retryableError });
          return;
        }

        void drain();
      });
    },

    retryLatest(content) {
      return new Promise<SerializedSaveResult>((resolve) => {
        const task = makeTask(content, resolve);
        if (queued) settle(queued, { status: "superseded" });
        queued = task;

        if (blocked) {
          settle(task, { status: "blocked" });
          queued = null;
          return;
        }

        retryableError = null;
        void drain();
      });
    },

    setPaused(nextPaused) {
      paused = nextPaused;
      if (!paused) void drain();
    },

    reset() {
      paused = false;
      blocked = false;
      retryableError = null;
      if (queued) settle(queued, { status: "blocked" });
      queued = null;
    },
  };
}
