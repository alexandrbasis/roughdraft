import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { RemoteBackend } from "../src/remote-backend";
import type { Page } from "../src/storage";

vi.mock("../src/DocumentWorkspace", () => ({
  DocumentWorkspace: ({ documentPage }: { documentPage: Page | null }) =>
    documentPage?.content,
}));

vi.mock("../src/RoughdraftFormatDemo", () => ({
  RoughdraftFormatDemo: () => null,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

it("opens the remote document with one read of the session", async () => {
  window.history.replaceState(null, "", "/?session=session-1");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(RemoteBackend.prototype, "watchMarkdownFile").mockReturnValue(
    () => {},
  );
  const readSession = vi.fn(() =>
    Response.json({
      id: "session-1",
      originPath: "/work/draft.md",
      content: "# Remote draft",
      version: "version-1",
    }),
  );
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "/api/status")
      return Response.json({ capabilities: { remoteDocuments: true } });
    if (url === "/api/remote-document/session-1") return readSession();
    return new Response(null, { status: 404 });
  });

  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<App />));
    expect(container.querySelector('[data-testid="homepage"]')).toBeNull();
    expect(container.textContent).toBe("# Remote draft");
    expect(readSession).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});
