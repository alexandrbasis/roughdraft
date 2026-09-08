import { EditorView } from "@codemirror/view";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DocumentWorkspace } from "./DocumentWorkspace";
import { createDraftStorage, type StoredDraft } from "./draft-storage";
import type { StorageBackend } from "./storage";

const testTime = Date.parse("2026-09-08T12:00:00.000Z");
const documentPath = "/project/notes.md";
const storageKey = documentPath;
const diskContent = "Original disk text";
const serverDraft: StoredDraft & { documentPath: string } = {
  documentPath,
  storageKey,
  content: "Unsaved text from the previous browser",
  baseContent: diskContent,
  baseVersion: "disk-v1",
  tabId: "previous-browser-tab",
  revision: "previous-browser-tab:1",
  updatedAt: testTime - 1000,
};

function setupDomMocks() {
  // jsdom has no layout. Keep editor behavior real and restore every DOM shim.
  const rect = {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: 640,
    height: 480,
    right: 640,
    bottom: 480,
    toJSON() {
      return this;
    },
  } as DOMRect;
  const restores: Array<() => void> = [];
  function define(target: object, key: string, value: unknown) {
    const original = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, value });
    restores.push(() => {
      if (original) Object.defineProperty(target, key, original);
      else Reflect.deleteProperty(target, key);
    });
  }
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    rect,
  );
  vi.spyOn(window, "scrollBy").mockImplementation(() => {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  define(document, "fonts", { ready: Promise.resolve() });
  define(Range.prototype, "getBoundingClientRect", () => rect);
  define(Range.prototype, "getClientRects", () => [rect]);
  define(HTMLElement.prototype, "getClientRects", () => [rect]);
  define(Text.prototype, "getClientRects", () => [rect]);
  return () => {
    for (const restore of restores.reverse()) restore();
  };
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("server-backed draft recovery", () => {
  let restoreDom: () => void;
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let props: ComponentProps<typeof DocumentWorkspace>;
  let records: Array<typeof serverDraft>;
  let status: Record<string, unknown>;
  let listResponse: (() => Promise<Response>) | undefined;
  let putResponse: ((draft: StoredDraft) => Promise<Response>) | undefined;
  let deleteResponse: (() => Promise<Response>) | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ now: testTime });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    sessionStorage.clear();
    restoreDom = setupDomMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    records = [{ ...serverDraft }];
    status = { serverDrafts: true };
    listResponse = undefined;
    putResponse = undefined;
    deleteResponse = undefined;
    fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/status") {
        return Response.json(status);
      }
      if (
        url.pathname === "/api/reviews/drafts" &&
        (!init?.method || init.method === "GET")
      ) {
        expect(url.searchParams.get("documentPath")).toBe(documentPath);
        return listResponse
          ? listResponse()
          : Response.json({ documentPath, drafts: records });
      }
      if (url.pathname === "/api/reviews/drafts" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as {
          documentPath: string;
          draft: StoredDraft;
        };
        expect(body.documentPath).toBe(documentPath);
        if (putResponse) return putResponse(body.draft);
        const record = { ...body.draft, documentPath: body.documentPath };
        records = records
          .filter((draft) => draft.tabId !== record.tabId)
          .concat(record);
        return Response.json(record);
      }
      if (url.pathname === "/api/reviews/drafts" && init?.method === "DELETE") {
        const body = JSON.parse(String(init.body)) as {
          documentPath: string;
          tabId: string;
          revision: string;
        };
        expect(body.documentPath).toBe(documentPath);
        if (deleteResponse) return deleteResponse();
        const before = records.length;
        records = records.filter(
          (draft) =>
            draft.tabId !== body.tabId || draft.revision !== body.revision,
        );
        return Response.json({ deleted: before !== records.length });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const backend: StorageBackend = {
      info: {
        kind: "local-files",
        label: "Local files",
        detail: "Test",
        projectPath: "/project",
      },
      canManageProjects: false,
      getMarkdownFile: vi.fn().mockResolvedValue(undefined),
      saveMarkdownFile: vi.fn().mockResolvedValue(undefined),
      saveAsset: vi.fn().mockResolvedValue(undefined),
      resolveFileUrl: () => null,
      openProject: vi.fn().mockResolvedValue(undefined),
    };
    props = {
      backend,
      documentPage: {
        id: "notes.md",
        title: "Notes",
        content: diskContent,
        version: "disk-v1",
      },
      activeDocumentPath: "notes.md",
      documentCopyPath: documentPath,
      documentFilenameLabel: "notes.md",
      draftStorageKey: storageKey,
      documentEditorViewMode: "code",
      onDocumentEditorViewModeChange: vi.fn(),
      onSaveDocument: vi.fn().mockResolvedValue(undefined),
      onDocumentSaveStateChange: vi.fn(),
      onDocumentDirtyStateChange: vi.fn(),
      onDocumentLocalContentChange: vi.fn(),
      documentDiskChangeState: "clean",
      documentForceResetKey: null,
      onReloadDocumentFromDisk: vi.fn().mockResolvedValue(undefined),
      onKeepEditingWithoutAutosave: vi.fn(),
      onOverwriteDocumentOnDisk: vi.fn().mockResolvedValue(undefined),
      onCompleteReview: vi.fn().mockResolvedValue({ delivered: false }),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    restoreDom();
    localStorage.clear();
    sessionStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function renderWorkspace() {
    await act(async () => root.render(<DocumentWorkspace {...props} />));
  }

  function byTestId(id: string) {
    return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  }

  function editor() {
    const element = container.querySelector<HTMLElement>(".cm-editor");
    assert(element, "The real CodeMirror editor must be mounted");
    const view = EditorView.findFromDOM(element);
    assert(view, "The mounted editor must have a CodeMirror view");
    return view;
  }

  async function edit(content: string) {
    await act(async () => {
      const view = editor();
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
      });
    });
  }

  async function advance(ms = 1000) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  function requests(method: string) {
    return fetchMock.mock.calls.filter(
      ([input, init]) =>
        new URL(String(input), "http://localhost").pathname ===
          "/api/reviews/drafts" && (init?.method ?? "GET") === method,
    );
  }

  async function press(id: string) {
    const button = byTestId(id);
    assert(button, `Expected the ${id} action to be available`);
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await click(button);
  }

  function localDrafts() {
    return createDraftStorage(localStorage).list(storageKey);
  }

  it("offers explicit recovery of a server draft when this browser has no local draft", async () => {
    await renderWorkspace();

    const recover = byTestId("draft-recovery-other");
    expect(
      recover,
      "A persisted server draft must be recoverable in a fresh browser",
    ).not.toBeNull();
    expect(container.querySelector(".cm-content")?.textContent).toBe(
      diskContent,
    );
    expect(props.onSaveDocument).not.toHaveBeenCalled();
    assert(recover);
    await click(recover);
    expect(container.querySelector(".cm-content")?.textContent).toBe(
      serverDraft.content,
    );
    expect(byTestId("draft-recovery-notice")?.textContent).toMatch(
      /server draft/i,
    );
    expect(
      createDraftStorage(localStorage)
        .list(storageKey)
        .some((draft) => draft.content === serverDraft.content),
    ).toBe(true);
  });

  it("rechecks the server source on explicit recovery instead of adopting the rendered snapshot", async () => {
    await renderWorkspace();
    expect(byTestId("draft-recovery-other")).not.toBeNull();
    const newer = {
      ...serverDraft,
      content: "Source updated after the recovery offer appeared",
      revision: "previous-browser-tab:2",
      updatedAt: Date.now(),
    };
    records = [newer];

    await press("draft-recovery-other");

    expect(editor().state.doc.toString()).toBe(newer.content);
    expect(props.onDocumentLocalContentChange).not.toHaveBeenCalledWith(
      serverDraft.content,
    );
    expect(localDrafts().some((draft) => draft.content === newer.content)).toBe(
      true,
    );
    expect(props.onSaveDocument).not.toHaveBeenCalled();
  });

  it("does not resurrect a server source removed after the recovery offer appeared", async () => {
    await renderWorkspace();
    expect(byTestId("draft-recovery-other")).not.toBeNull();
    records = [];

    await press("draft-recovery-other");

    expect(editor().state.doc.toString()).toBe(diskContent);
    expect(byTestId("draft-recovery-other")).toBeNull();
    expect(localDrafts()).toEqual([]);
    expect(requests("PUT")).toHaveLength(0);
    expect(props.onSaveDocument).not.toHaveBeenCalled();
  });

  it("keeps edits typed while an explicit recovery GET is pending", async () => {
    await renderWorkspace();
    const pending = deferred<Response>();
    const get = vi.fn(() => pending.promise);
    listResponse = get;
    await press("draft-recovery-other");
    expect(get).toHaveBeenCalledOnce();
    await edit("Work typed after clicking recover");
    const local = localDrafts().find(
      (draft) => draft.content === "Work typed after clicking recover",
    );
    assert(local);

    await act(async () =>
      pending.resolve(Response.json({ documentPath, drafts: [serverDraft] })),
    );

    expect(editor().state.doc.toString()).toBe(local.content);
    expect(localDrafts()).toContainEqual(local);
    expect(props.onDocumentLocalContentChange).not.toHaveBeenCalledWith(
      serverDraft.content,
    );
    expect(props.onSaveDocument).not.toHaveBeenCalled();
  });

  it("rereads local copies updated while explicit recovery awaits the server", async () => {
    const storage = createDraftStorage(localStorage);
    storage.write(serverDraft);
    await renderWorkspace();
    const pending = deferred<Response>();
    const get = vi.fn(() => pending.promise);
    listResponse = get;
    await press("draft-recovery-other");
    expect(get).toHaveBeenCalledOnce();
    const newerLocal: StoredDraft = {
      ...serverDraft,
      content: "Other tab updated its browser draft during recovery GET",
      revision: "previous-browser-tab:2",
      updatedAt: Date.now(),
    };
    storage.write(newerLocal);

    await act(async () =>
      pending.resolve(Response.json({ documentPath, drafts: [serverDraft] })),
    );

    expect(editor().state.doc.toString()).toBe(newerLocal.content);
    expect(props.onDocumentLocalContentChange).not.toHaveBeenCalledWith(
      serverDraft.content,
    );
    expect(
      localDrafts().filter((draft) => draft.content === newerLocal.content),
    ).toHaveLength(2);
    expect(props.onSaveDocument).not.toHaveBeenCalled();
  });

  it("does not adopt a delayed GET after the user starts editing", async () => {
    const pending = deferred<Response>();
    listResponse = () => pending.promise;
    await renderWorkspace();
    expect(requests("GET")).toHaveLength(1);
    await edit("New work typed while recovery was loading");
    const local = localDrafts().find(
      (draft) => draft.content === "New work typed while recovery was loading",
    );
    assert(local, "Editing must synchronously create a browser draft");

    await act(async () =>
      pending.resolve(Response.json({ documentPath, drafts: [serverDraft] })),
    );

    expect(editor().state.doc.toString()).toBe(local.content);
    expect(props.onDocumentLocalContentChange).not.toHaveBeenCalledWith(
      serverDraft.content,
    );
    expect(localDrafts()).toContainEqual(local);
    const recover = byTestId(
      "draft-recovery-other",
    ) as HTMLButtonElement | null;
    expect(recover === null || recover.disabled).toBe(true);
    expect(props.onSaveDocument).not.toHaveBeenCalled();
  });

  it("keeps Save failed visible when a delayed GET returns an older same-tab draft", async () => {
    records = [];
    props.onSaveDocument = vi
      .fn()
      .mockRejectedValue(new Error("Disk save 503"));
    await renderWorkspace();
    await edit("Older mirrored edit from this tab");
    const older = localDrafts()[0];
    assert(older);
    expect(records).toContainEqual({ ...older, documentPath });

    await edit("Newer edit retained after disk save fails");
    const newer = localDrafts()[0];
    assert(newer);
    expect(newer.tabId).toBe(older.tabId);
    expect(newer.revision).not.toBe(older.revision);
    await advance(500);
    expect(props.onSaveDocument).toHaveBeenCalledExactlyOnceWith(
      "notes.md",
      newer.content,
    );
    expect(byTestId("document-save-status")?.getAttribute("aria-label")).toBe(
      "Save failed",
    );

    // Recreate the client after both edits so its GET generation filter accepts
    // the stale same-tab snapshot, as a fresh backend connection would.
    const pending = deferred<Response>();
    listResponse = () => pending.promise;
    assert(props.backend);
    props.backend = { ...props.backend };
    await renderWorkspace();
    expect(requests("GET")).toHaveLength(2);
    expect(byTestId("draft-recovery-notice")).toBeNull();
    expect(byTestId("document-save-status")?.getAttribute("aria-label")).toBe(
      "Save failed",
    );
    await act(async () =>
      pending.resolve(
        Response.json({ documentPath, drafts: [{ ...older, documentPath }] }),
      ),
    );

    expect(editor().state.doc.toString()).toBe(newer.content);
    expect(localDrafts()).toContainEqual(newer);
    expect(byTestId("document-save-status")?.getAttribute("aria-label")).toBe(
      "Save failed",
    );
  });

  it("keeps changed disk content until explicit recovery and requires explicit overwrite", async () => {
    assert(props.documentPage);
    props.documentPage = {
      ...props.documentPage,
      content: "New disk version",
      version: "disk-v2",
    };
    await renderWorkspace();
    await press("draft-recovery-other");
    expect(editor().state.doc.toString()).toBe("New disk version");
    expect(byTestId("draft-recovery-notice")?.textContent).toMatch(
      /disk.*changed/i,
    );
    await advance();
    expect(props.onSaveDocument).not.toHaveBeenCalled();

    await press("draft-recovery-recover-local");
    expect(editor().state.doc.toString()).toBe(serverDraft.content);
    expect(
      localDrafts().some((draft) => draft.content === serverDraft.content),
    ).toBe(true);
    await edit("Recovered text plus more edits");
    await advance();
    expect(props.onSaveDocument).not.toHaveBeenCalled();
    expect(props.onOverwriteDocumentOnDisk).not.toHaveBeenCalled();
    await press("draft-recovery-overwrite");
    expect(props.onOverwriteDocumentOnDisk).toHaveBeenCalledOnce();
  });

  it("lets the user keep changed disk content without saving the server draft", async () => {
    assert(props.documentPage);
    props.documentPage = {
      ...props.documentPage,
      content: "New disk version",
      version: "disk-v2",
    };
    await renderWorkspace();
    await press("draft-recovery-other");
    await press("draft-recovery-keep-disk");
    expect(props.onReloadDocumentFromDisk).toHaveBeenCalledOnce();
    expect(editor().state.doc.toString()).toBe("New disk version");
    expect(props.onSaveDocument).not.toHaveBeenCalled();
    expect(props.onOverwriteDocumentOnDisk).not.toHaveBeenCalled();
  });

  it.each([
    "initial GET",
    "recovery GET",
  ])("keeps browser recovery usable when the advertised server fails on %s", async (failureAt) => {
    const local: StoredDraft = {
      ...serverDraft,
      content: "Recoverable browser copy despite server outage",
      tabId: "other-local-tab",
      revision: "other-local-tab:1",
      updatedAt: testTime - 2000,
    };
    createDraftStorage(localStorage).write(local);
    const unavailable = vi.fn(async () =>
      Response.json({ error: "Server unavailable" }, { status: 503 }),
    );
    if (failureAt === "initial GET") listResponse = unavailable;
    await renderWorkspace();
    // The cached server candidate is newer than the local one. A failed refresh
    // must exclude it rather than silently selecting that stale remote content.
    listResponse = unavailable;
    putResponse = unavailable;

    await press("draft-recovery-other");

    expect(unavailable).toHaveBeenCalled();
    expect(editor().state.doc.toString()).toBe(local.content);
    expect(props.onDocumentLocalContentChange).not.toHaveBeenCalledWith(
      serverDraft.content,
    );
    expect(
      localDrafts().filter((draft) => draft.content === local.content),
    ).toHaveLength(2);
    expect(byTestId("draft-recovery-notice")?.textContent).not.toMatch(
      /recovered.*server draft/i,
    );
    expect(props.onSaveDocument).not.toHaveBeenCalled();
    expect(requests("DELETE")).toHaveLength(0);
  });

  it("never recovers a cached remote candidate after GET failure when no local copy exists", async () => {
    await renderWorkspace();
    expect(byTestId("draft-recovery-other")).not.toBeNull();
    listResponse = async () =>
      Response.json({ error: "Server unavailable" }, { status: 503 });

    await press("draft-recovery-other");

    expect(editor().state.doc.toString()).toBe(diskContent);
    expect(localDrafts()).toEqual([]);
    expect(props.onDocumentLocalContentChange).not.toHaveBeenCalledWith(
      serverDraft.content,
    );
    expect(requests("PUT")).toHaveLength(0);
    expect(props.onSaveDocument).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="server-draft-error"]')
        ?.textContent,
    ).toMatch(/server.*draft|draft.*server/i);
  });

  it.each([
    false,
    true,
  ])("cleans the server draft after a quota-blocked edit and successful disk save (older local copy: %s)", async (hasOlderLocalCopy) => {
    records = [];
    await renderWorkspace();
    if (hasOlderLocalCopy)
      await edit("Older edit persisted before the browser quota was reached");
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (this === localStorage && key.startsWith("roughdraft:draft:v1:")) {
        throw new DOMException(
          "Browser draft quota exceeded",
          "QuotaExceededError",
        );
      }
      setItem.call(this, key, value);
    });
    await edit("Saved using the server copy while browser storage is full");
    const mirrored = records.find(
      (draft) =>
        draft.content ===
        "Saved using the server copy while browser storage is full",
    );
    assert(mirrored, "Quota failure must still leave a server recovery copy");
    expect(localDrafts().map((draft) => draft.content)).toEqual(
      hasOlderLocalCopy
        ? ["Older edit persisted before the browser quota was reached"]
        : [],
    );
    expect(byTestId("draft-storage-error")?.textContent).toMatch(/full/i);

    await advance(500);

    expect(props.onSaveDocument).toHaveBeenCalledWith(
      "notes.md",
      mirrored.content,
    );
    expect(
      requests("DELETE").map(([, init]) => JSON.parse(String(init?.body))),
    ).toContainEqual({
      documentPath,
      tabId: mirrored.tabId,
      revision: mirrored.revision,
    });
    expect(records).not.toContainEqual(mirrored);
  });

  it("warns on GET failure while preserving new edits in browser storage", async () => {
    listResponse = async () =>
      Response.json({ error: "Draft store unavailable" }, { status: 503 });
    props.documentDiskChangeState = "paused";
    await renderWorkspace();
    expect(
      container.querySelector('[data-testid="server-draft-error"]')
        ?.textContent,
    ).toMatch(/server.*draft|draft.*server/i);
    await edit("Locally recoverable despite server failure");
    expect(editor().state.doc.toString()).toBe(
      "Locally recoverable despite server failure",
    );
    expect(
      localDrafts().some(
        (draft) =>
          draft.content === "Locally recoverable despite server failure",
      ),
    ).toBe(true);
    expect(props.onSaveDocument).not.toHaveBeenCalled();
  });

  it.each([
    "http",
    "network",
  ])("warns on %s PUT failure and retains the local draft", async (failure) => {
    records = [];
    props.documentDiskChangeState = "paused";
    putResponse = async () => {
      if (failure === "network") throw new TypeError("Failed to fetch");
      return Response.json(
        { error: "Draft store unavailable" },
        { status: 503 },
      );
    };
    await renderWorkspace();
    await edit("Edits must survive failed server persistence");
    await advance();
    expect(requests("PUT").length).toBeGreaterThan(0);
    expect(
      container.querySelector('[data-testid="server-draft-error"]')
        ?.textContent,
    ).toMatch(/server.*draft|draft.*server/i);
    expect(editor().state.doc.toString()).toBe(
      "Edits must survive failed server persistence",
    );
    expect(
      localDrafts().some(
        (draft) =>
          draft.content === "Edits must survive failed server persistence",
      ),
    ).toBe(true);
  });

  it.each([
    { serverDrafts: true },
    { capabilities: { serverDrafts: true } },
  ])("accepts the advertised capability %j", async (capability) => {
    status = capability;
    await renderWorkspace();
    expect(requests("GET")).toHaveLength(1);
    expect(byTestId("draft-recovery-other")).not.toBeNull();
    expect(editor().state.doc.toString()).toBe(diskContent);
  });

  it.each([
    "local-storage",
    "remote",
  ] as const)("never sends drafts for the %s backend", async (kind) => {
    assert(props.backend);
    props.backend = { ...props.backend, info: { ...props.backend.info, kind } };
    props.documentDiskChangeState = "paused";
    await renderWorkspace();
    await edit("Private browser or remote edits");
    await advance();
    expect(requests("GET")).toHaveLength(0);
    expect(requests("PUT")).toHaveLength(0);
    expect(requests("DELETE")).toHaveLength(0);
    expect(byTestId("draft-recovery-other")).toBeNull();
    expect(
      localDrafts().some(
        (draft) => draft.content === "Private browser or remote edits",
      ),
    ).toBe(true);
  });

  it.each([
    {},
    { serverDrafts: false },
    { capabilities: { serverDrafts: false } },
  ])("keeps old servers on browser-only recovery for status %j", async (capability) => {
    status = capability;
    props.documentDiskChangeState = "paused";
    await renderWorkspace();
    await edit("Browser draft on an old server");
    await advance();
    expect(requests("GET")).toHaveLength(0);
    expect(requests("PUT")).toHaveLength(0);
    expect(requests("DELETE")).toHaveLength(0);
    expect(
      container.querySelector('[data-testid="server-draft-error"]'),
    ).toBeNull();
    expect(
      localDrafts().some(
        (draft) => draft.content === "Browser draft on an old server",
      ),
    ).toBe(true);
  });

  it("preserves a newer server revision when cleanup loses its compare-and-swap", async () => {
    await renderWorkspace();
    await press("draft-recovery-other");
    const newer = {
      ...serverDraft,
      content: "Newer draft from the original tab",
      revision: "previous-browser-tab:2",
      updatedAt: testTime + 1,
    };
    records = records.map((draft) =>
      draft.tabId === serverDraft.tabId ? newer : draft,
    );
    await press("draft-recovery-save");
    await advance();

    expect(props.onSaveDocument).toHaveBeenCalledWith(
      "notes.md",
      serverDraft.content,
    );
    const deletes = requests("DELETE").map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(deletes).toContainEqual({
      documentPath,
      tabId: serverDraft.tabId,
      revision: serverDraft.revision,
    });
    expect(deletes).not.toContainEqual({
      documentPath,
      tabId: newer.tabId,
      revision: newer.revision,
    });
    expect(records).toContainEqual(newer);
    expect(editor().state.doc.toString()).not.toBe(newer.content);
  });

  it("warns when cleanup cannot remove a saved recovery source from the server", async () => {
    const pending = deferred<Response>();
    deleteResponse = () => pending.promise;
    await renderWorkspace();
    await press("draft-recovery-other");
    await press("draft-recovery-save");
    expect(props.onSaveDocument).toHaveBeenCalledWith(
      "notes.md",
      serverDraft.content,
    );
    expect(requests("DELETE").length).toBeGreaterThan(0);

    await act(async () =>
      pending.resolve(
        Response.json({ error: "Draft store unavailable" }, { status: 503 }),
      ),
    );

    expect(
      container.querySelector('[data-testid="server-draft-error"]')
        ?.textContent,
    ).toMatch(/server.*draft|draft.*server/i);
    expect(records).toContainEqual(serverDraft);
  });

  it("preserves edits made during an in-flight save in browser and server drafts", async () => {
    records = [];
    const save = deferred<void>();
    props.onSaveDocument = vi.fn(() => save.promise);
    await renderWorkspace();
    await edit("First edit being saved");
    await advance(500);
    expect(props.onSaveDocument).toHaveBeenCalledWith(
      "notes.md",
      "First edit being saved",
    );
    await edit("Newer edit while the first save is pending");
    const newer = localDrafts().find(
      (draft) => draft.content === "Newer edit while the first save is pending",
    );
    assert(newer, "The newer edit must already have a local recovery copy");
    await act(async () => save.resolve());

    expect(localDrafts()).toContainEqual(newer);
    expect(records.some((draft) => draft.content === newer.content)).toBe(true);
    expect(editor().state.doc.toString()).toBe(newer.content);
    expect(
      requests("DELETE").some(
        ([, init]) =>
          JSON.parse(String(init?.body)).revision === newer.revision,
      ),
    ).toBe(false);
  });
});
