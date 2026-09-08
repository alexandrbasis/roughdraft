import type { BackendInfo, Page } from "./storage";

const STORAGE_PREFIX = "roughdraft:draft:v1:";

export interface DraftDocumentSnapshot {
  content: string;
  version?: string | null;
}

export interface StoredDraft {
  storageKey: string;
  content: string;
  baseContent: string;
  baseVersion: string | null;
  revision: string;
  tabId: string;
  updatedAt: number;
}

export type DraftRecovery =
  | { kind: "none" }
  | { kind: "safe"; draft: StoredDraft }
  | { kind: "disk-changed"; draft: StoredDraft };

export type DraftStorageErrorKind = "unavailable" | "quota" | "corrupt";

export class DraftStorageError extends Error {
  readonly kind: DraftStorageErrorKind;

  constructor(kind: DraftStorageErrorKind, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "DraftStorageError";
    this.kind = kind;
  }
}

export interface DraftStorage {
  read(storageKey: string, tabId?: string): StoredDraft | null;
  list(storageKey: string): StoredDraft[];
  write(draft: StoredDraft): void;
  removeIfRevision(
    storageKey: string,
    revision: string,
    tabId?: string,
  ): boolean;
}

function normalizeVersion(version: string | null | undefined): string | null {
  return version ?? null;
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" || error.code === 22)
  );
}

function storageError(operation: string, error: unknown): DraftStorageError {
  if (isQuotaError(error)) {
    return new DraftStorageError(
      "quota",
      `Could not ${operation} because browser draft storage is full.`,
      error,
    );
  }

  return new DraftStorageError(
    "unavailable",
    `Could not ${operation} because browser draft storage is unavailable.`,
    error,
  );
}

function tabRecordKey(storageKey: string, tabId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(storageKey)}:${encodeURIComponent(tabId)}`;
}

function recordPrefix(storageKey: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(storageKey)}:`;
}

function parseStoredDraft(storageKey: string, raw: string): StoredDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DraftStorageError(
      "corrupt",
      "The saved browser draft is not readable.",
      error,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new DraftStorageError(
      "corrupt",
      "The saved browser draft is not readable.",
    );
  }

  const candidate = parsed as Partial<StoredDraft>;
  if (
    candidate.storageKey !== storageKey ||
    typeof candidate.content !== "string" ||
    typeof candidate.baseContent !== "string" ||
    (typeof candidate.baseVersion !== "string" &&
      candidate.baseVersion !== null) ||
    typeof candidate.revision !== "string" ||
    typeof candidate.tabId !== "string" ||
    typeof candidate.updatedAt !== "number"
  ) {
    throw new DraftStorageError(
      "corrupt",
      "The saved browser draft is not readable.",
    );
  }

  return {
    storageKey,
    content: candidate.content,
    baseContent: candidate.baseContent,
    baseVersion: candidate.baseVersion,
    revision: candidate.revision,
    tabId: candidate.tabId,
    updatedAt: candidate.updatedAt,
  };
}

export function createDraftStorage(storage: Storage): DraftStorage {
  return {
    read(storageKey, tabId) {
      try {
        const drafts = this.list(storageKey);
        if (tabId) {
          return drafts.find((draft) => draft.tabId === tabId) ?? null;
        }
        return drafts.at(-1) ?? null;
      } catch (error) {
        if (error instanceof DraftStorageError) throw error;
        throw storageError("read the browser draft", error);
      }
    },

    list(storageKey) {
      try {
        const prefix = recordPrefix(storageKey);
        const drafts: StoredDraft[] = [];
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (!key?.startsWith(prefix)) continue;

          const raw = storage.getItem(key);
          if (raw) drafts.push(parseStoredDraft(storageKey, raw));
        }
        return drafts.sort((left, right) => left.updatedAt - right.updatedAt);
      } catch (error) {
        if (error instanceof DraftStorageError) throw error;
        throw storageError("read the browser drafts", error);
      }
    },

    write(draft) {
      try {
        storage.setItem(
          tabRecordKey(draft.storageKey, draft.tabId),
          JSON.stringify(draft),
        );
      } catch (error) {
        throw storageError("save the browser draft", error);
      }
    },

    removeIfRevision(storageKey, revision, tabId) {
      try {
        const current = this.list(storageKey).find(
          (draft) =>
            draft.revision === revision && (!tabId || draft.tabId === tabId),
        );
        if (!current) return false;

        storage.removeItem(tabRecordKey(storageKey, current.tabId));
        return true;
      } catch (error) {
        if (error instanceof DraftStorageError) throw error;
        throw storageError("remove the browser draft", error);
      }
    },
  };
}

export function isDraftStorageKeyForDocument(
  storageEventKey: string,
  storageKey: string,
): boolean {
  return storageEventKey.startsWith(recordPrefix(storageKey));
}

export function createBrowserDraftStorage(): DraftStorage {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      throw new Error("localStorage is unavailable");
    }
    return createDraftStorage(window.localStorage);
  } catch (error) {
    if (error instanceof DraftStorageError) throw error;
    throw storageError("access browser draft storage", error);
  }
}

let lastDraftTimestamp = 0;

function nextDraftTimestamp() {
  lastDraftTimestamp = Math.max(Date.now(), lastDraftTimestamp + 1);
  return lastDraftTimestamp;
}

export function createDraftRecord({
  storageKey,
  content,
  base,
  revision,
  tabId,
  updatedAt = nextDraftTimestamp(),
}: {
  storageKey: string;
  content: string;
  base: DraftDocumentSnapshot;
  revision: string;
  tabId: string;
  updatedAt?: number;
}): StoredDraft {
  return {
    storageKey,
    content,
    baseContent: base.content,
    baseVersion: normalizeVersion(base.version),
    revision,
    tabId,
    updatedAt,
  };
}

export function inspectDraftRecovery(
  draft: StoredDraft | null,
  current: DraftDocumentSnapshot,
): DraftRecovery {
  if (!draft) return { kind: "none" };

  const baseMatches =
    draft.baseContent === current.content &&
    draft.baseVersion === normalizeVersion(current.version);

  return baseMatches
    ? { kind: "safe", draft }
    : { kind: "disk-changed", draft };
}

export function getCanonicalDocumentIdentity(
  info: BackendInfo,
  relativePath: string,
  explicitKey?: string | null,
): string {
  if (explicitKey?.trim()) return explicitKey.trim();

  return JSON.stringify({
    backend: info.kind,
    projectPath: info.projectPath ?? null,
    sessionId: info.sessionId ?? null,
    originPath: info.originPath ?? null,
    relativePath: relativePath.replaceAll("\\", "/"),
  });
}

export function getDraftStorageKey(
  info: BackendInfo,
  relativePath: string,
  explicitKey?: string | null,
): string {
  return getCanonicalDocumentIdentity(info, relativePath, explicitKey);
}

let tabSequence = 0;
const TAB_ID_STORAGE_KEY = "roughdraft:draft-tab-id:v1";

export function getDraftTabId(): string {
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      const existingTabId = window.sessionStorage.getItem(TAB_ID_STORAGE_KEY);
      if (existingTabId) return existingTabId;

      const tabId = createDraftTabId();
      window.sessionStorage.setItem(TAB_ID_STORAGE_KEY, tabId);
      return tabId;
    }
  } catch {
    // Fall through when sessionStorage is blocked or unavailable.
  }

  return createDraftTabId();
}

function createDraftTabId(): string {
  tabSequence += 1;
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;

  try {
    const randomValues = globalThis.crypto?.getRandomValues?.(
      new Uint32Array(2),
    );
    if (randomValues) {
      return `tab-${randomValues[0].toString(16)}-${randomValues[1].toString(16)}`;
    }
  } catch {
    // Fall through to the best available non-cryptographic fallback.
  }

  return `tab-${Date.now().toString(36)}-${tabSequence}`;
}

let revisionSequence = 0;

export function getDraftRevision(tabId: string): string {
  revisionSequence += 1;
  return `${Date.now().toString(36)}-${revisionSequence.toString(36)}-${tabId}`;
}

export function pageSnapshot(page: Page): DraftDocumentSnapshot {
  return {
    content: page.content,
    version: page.version,
  };
}
