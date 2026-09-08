import type { StoredDraft } from "./draft-storage";
import type { BackendInfo } from "./storage";

export interface ServerDraft extends StoredDraft {
  documentPath: string;
}

export interface ServerDraftClient {
  list(): Promise<ServerDraft[]>;
  put(draft: StoredDraft): Promise<ServerDraft | null>;
  remove(draft: StoredDraft): Promise<boolean>;
}

// Shared across workspace remounts so an old request cannot overtake a new one.
const queues = new Map<string, Promise<unknown>>();
const generations = new Map<string, number>();

function parseDraft(value: unknown, documentPath: string): ServerDraft {
  if (!value || typeof value !== "object")
    throw new Error("Invalid server draft");
  const draft = value as Partial<ServerDraft>;
  if (
    draft.documentPath !== documentPath ||
    typeof draft.storageKey !== "string" ||
    typeof draft.content !== "string" ||
    typeof draft.baseContent !== "string" ||
    (draft.baseVersion !== null && typeof draft.baseVersion !== "string") ||
    typeof draft.tabId !== "string" ||
    !draft.tabId ||
    typeof draft.revision !== "string" ||
    !draft.revision ||
    typeof draft.updatedAt !== "number" ||
    !Number.isFinite(draft.updatedAt)
  )
    throw new Error("Invalid server draft");
  return draft as ServerDraft;
}

export function createServerDraftClient(
  info: BackendInfo,
  documentPath: string,
): ServerDraftClient | null {
  if (info.kind !== "local-files" || !/^(\/|[A-Za-z]:[\\/])/.test(documentPath))
    return null;

  // Match ApiBackend: same-origin /api routes also use the local Vite proxy.
  const endpoint = "/api/reviews/drafts";
  let canonicalPath = documentPath;
  let initialRead: Promise<ServerDraft[]> | undefined;
  let capability: Promise<boolean> | undefined =
    info.capabilities?.serverDrafts === undefined
      ? undefined
      : Promise.resolve(info.capabilities.serverDrafts);
  function supported() {
    capability ??= fetch("/api/status")
      .then(async (response) => {
        if (!response.ok) return false;
        const status = await response.json();
        return (
          status.serverDrafts === true ||
          status.capabilities?.serverDrafts === true
        );
      })
      .catch(() => false);
    return capability;
  }
  const key = (tabId: string) => JSON.stringify([documentPath, tabId]);
  function enqueue<T>(tabId: string, operation: () => Promise<T>): Promise<T> {
    const queueKey = key(tabId);
    generations.set(queueKey, (generations.get(queueKey) ?? 0) + 1);
    const pending = (queues.get(queueKey) ?? Promise.resolve())
      .catch(() => {})
      .then(operation);
    queues.set(queueKey, pending);
    void pending.then(
      () => {
        if (queues.get(queueKey) === pending) queues.delete(queueKey);
      },
      () => {
        if (queues.get(queueKey) === pending) queues.delete(queueKey);
      },
    );
    return pending;
  }
  async function request(method: string, body: unknown) {
    const response = await fetch(endpoint, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(`Server draft ${method} failed: ${response.status}`);
    return response.json();
  }

  async function readDrafts(): Promise<ServerDraft[]> {
    const started = new Map(generations);
    const response = await fetch(
      `${endpoint}?${new URLSearchParams({ documentPath: canonicalPath })}`,
    );
    if (!response.ok)
      throw new Error(`Server draft recovery failed: ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.drafts))
      throw new Error("Invalid server draft list");
    if (payload.documentPath !== undefined) {
      if (
        typeof payload.documentPath !== "string" ||
        !/^(\/|[A-Za-z]:[\\/])/.test(payload.documentPath)
      )
        throw new Error("Invalid canonical draft path");
      if (
        canonicalPath !== documentPath &&
        canonicalPath !== payload.documentPath
      )
        throw new Error("Server draft document changed");
      canonicalPath = payload.documentPath;
    }
    return payload.drafts
      .map((value: unknown) => parseDraft(value, canonicalPath))
      .filter(
        (draft: ServerDraft) =>
          (started.get(key(draft.tabId)) ?? 0) ===
          (generations.get(key(draft.tabId)) ?? 0),
      );
  }
  function initialize() {
    initialRead ??= readDrafts().catch((error) => {
      initialRead = undefined;
      throw error;
    });
    return initialRead;
  }

  return {
    async list() {
      if (!(await supported())) return [];
      if (!initialRead) return initialize();
      await initialize();
      await Promise.allSettled(
        [...queues.entries()]
          .filter(([queueKey]) => JSON.parse(queueKey)[0] === documentPath)
          .map(([, pending]) => pending),
      );
      return readDrafts();
    },
    put(draft) {
      return enqueue(draft.tabId, async () => {
        if (!(await supported())) return null;
        await initialize();
        const saved = parseDraft(
          await request("PUT", { documentPath: canonicalPath, draft }),
          canonicalPath,
        );
        if (
          Object.keys(draft).some(
            (field) =>
              saved[field as keyof StoredDraft] !==
              draft[field as keyof StoredDraft],
          )
        ) {
          throw new Error("Server acknowledged a different draft revision");
        }
        return saved;
      });
    },
    remove(draft) {
      return enqueue(draft.tabId, async () => {
        if (!(await supported())) return false;
        await initialize();
        const result = await request("DELETE", {
          documentPath: canonicalPath,
          tabId: draft.tabId,
          revision: draft.revision,
        });
        if (typeof result.deleted !== "boolean")
          throw new Error("Invalid server draft deletion acknowledgement");
        return result.deleted;
      });
    },
  };
}
