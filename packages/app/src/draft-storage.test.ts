import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDraftRecord,
  createDraftStorage,
  getDraftTabId,
  inspectDraftRecovery,
  type DraftDocumentSnapshot,
} from "./draft-storage";

afterEach(() => {
  vi.unstubAllGlobals();
});

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const baseDocument: DraftDocumentSnapshot = {
  content: "# Original\n",
  version: "disk-v1",
};

describe("browser draft storage", () => {
  it("uses insecure-origin crypto randomness when randomUUID is unavailable", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("crypto", {
      getRandomValues(values: Uint32Array) {
        values[0] = 0x12345678;
        return values;
      },
    });
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    expect(getDraftTabId()).toContain("12345678");
  });

  it("recovers a pending draft after a failed save and a reload when disk is unchanged", () => {
    const storage = createDraftStorage(new MemoryStorage());
    const key = "roughdraft:v1:local-files:/project/review.md";
    const draft = createDraftRecord({
      storageKey: key,
      content: "# Local review\n",
      base: baseDocument,
      revision: "tab-a:2",
      tabId: "tab-a",
      updatedAt: 10,
    });

    storage.write(draft);

    expect(inspectDraftRecovery(storage.read(key), baseDocument)).toEqual({
      kind: "safe",
      draft,
    });
  });

  it("preserves a newer tab draft when an older tab confirms its save", () => {
    const backing = new MemoryStorage();
    const storage = createDraftStorage(backing);
    const key = "roughdraft:v1:local-files:/project/review.md";
    const olderDraft = createDraftRecord({
      storageKey: key,
      content: "# Older local review\n",
      base: baseDocument,
      revision: "tab-a:2",
      tabId: "tab-a",
      updatedAt: 10,
    });
    const newerDraft = createDraftRecord({
      storageKey: key,
      content: "# Newer local review\n",
      base: baseDocument,
      revision: "tab-b:4",
      tabId: "tab-b",
      updatedAt: 20,
    });

    storage.write(olderDraft);
    storage.write(newerDraft);

    expect(storage.read(key, olderDraft.tabId)).toEqual(olderDraft);
    expect(storage.read(key, newerDraft.tabId)).toEqual(newerDraft);
    expect(
      storage.removeIfRevision(key, olderDraft.revision, olderDraft.tabId),
    ).toBe(true);
    expect(storage.read(key)).toEqual(newerDraft);
  });

  it("stores same-document drafts separately for each tab", () => {
    const storage = createDraftStorage(new MemoryStorage());
    const key = "roughdraft:v1:local-files:/project/review.md";
    const firstTabDraft = createDraftRecord({
      storageKey: key,
      content: "# First tab\n",
      base: baseDocument,
      revision: "tab-a:2",
      tabId: "tab-a",
      updatedAt: 10,
    });
    const secondTabDraft = createDraftRecord({
      storageKey: key,
      content: "# Second tab\n",
      base: baseDocument,
      revision: "tab-b:4",
      tabId: "tab-b",
      updatedAt: 20,
    });

    storage.write(firstTabDraft);
    storage.write(secondTabDraft);

    expect(storage.read(key, "tab-a")).toEqual(firstTabDraft);
    expect(storage.read(key, "tab-b")).toEqual(secondTabDraft);
    expect(storage.list(key)).toEqual([firstTabDraft, secondTabDraft]);
    expect(storage.removeIfRevision(key, firstTabDraft.revision, "tab-a")).toBe(
      true,
    );
    expect(storage.read(key, "tab-b")).toEqual(secondTabDraft);
  });

  it("requires explicit recovery when the disk version changed", () => {
    const storage = createDraftStorage(new MemoryStorage());
    const key = "roughdraft:v1:local-files:/project/review.md";
    const draft = createDraftRecord({
      storageKey: key,
      content: "# Local review\n",
      base: baseDocument,
      revision: "tab-a:2",
      tabId: "tab-a",
      updatedAt: 10,
    });

    storage.write(draft);

    expect(
      inspectDraftRecovery(storage.read(key), {
        content: "# External review\n",
        version: "disk-v2",
      }),
    ).toEqual({
      kind: "disk-changed",
      draft,
    });
  });
});
