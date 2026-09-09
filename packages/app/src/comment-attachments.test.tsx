import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentAssetContext, CommentBody } from "./CommentBody";
import { CommentComposer } from "./CommentComposer";
import type { StorageBackend, StoredAsset } from "./storage";

const asset: StoredAsset = {
  markdownPath: "assets/screenshot.png",
  previewUrl: "/api/assets/screenshot.png",
  mimeType: "image/png",
};

function createBackend(kind: StorageBackend["info"]["kind"] = "local-files") {
  return {
    info: { kind, label: "Test", detail: "Test" },
    canManageProjects: false,
    getMarkdownFile: vi.fn<StorageBackend["getMarkdownFile"]>(),
    saveMarkdownFile: vi.fn<StorageBackend["saveMarkdownFile"]>(),
    saveAsset: vi.fn<StorageBackend["saveAsset"]>().mockResolvedValue(asset),
    resolveFileUrl: vi.fn(() => asset.previewUrl),
    openProject: vi.fn<StorageBackend["openProject"]>(),
  } satisfies StorageBackend;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function Composer({
  backend,
  onUploadingChange,
}: {
  backend: StorageBackend;
  onUploadingChange: (uploading: boolean) => void;
}) {
  const [value, setValue] = useState("Before upload");
  return (
    <CommentComposer
      data-testid="attachment-composer"
      value={value}
      onChange={setValue}
      backend={backend}
      onUploadingChange={onUploadingChange}
    />
  );
}

describe("comment image interactions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function textarea() {
    const element = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="attachment-composer"]',
    );
    if (!element) throw new Error("Comment input was not rendered");
    return element;
  }

  async function pasteImage() {
    const file = new File(["image bytes"], "screenshot.png", {
      type: "image/png",
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: [{ kind: "file", type: file.type, getAsFile: () => file }],
      },
    });
    await act(async () => textarea().dispatchEvent(event));
    return { file, event };
  }

  async function typeText(value: string) {
    await act(async () => {
      const input = textarea();
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      if (!setter) throw new Error("Textarea value setter is unavailable");
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("preserves text typed while attaching and reports the pending interval", async () => {
    const backend = createBackend();
    const pending = deferred<StoredAsset>();
    backend.saveAsset.mockReturnValue(pending.promise);
    const onUploadingChange = vi.fn();
    await act(async () => {
      root.render(
        <Composer backend={backend} onUploadingChange={onUploadingChange} />,
      );
    });

    const { file } = await pasteImage();
    expect(backend.saveAsset).toHaveBeenCalledExactlyOnceWith(file);
    expect(onUploadingChange.mock.calls).toEqual([[true]]);
    expect(textarea().disabled).toBe(false);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="attachment-composer-attach"]',
      )?.disabled,
    ).toBe(true);

    await typeText("Before upload, with more detail");
    await pasteImage();
    expect(backend.saveAsset).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(asset));

    expect(textarea().value).toBe(
      "Before upload, with more detail\n\n![screenshot.png](assets/screenshot.png)",
    );
    expect(onUploadingChange.mock.calls).toEqual([[true], [false]]);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="attachment-composer-attach"]',
      )?.disabled,
    ).toBe(false);
  });

  it("keeps the comment after a failed upload and allows retrying the image", async () => {
    const backend = createBackend();
    backend.saveAsset.mockRejectedValueOnce(new Error("Disk is full"));
    const onUploadingChange = vi.fn();
    await act(async () => {
      root.render(
        <Composer backend={backend} onUploadingChange={onUploadingChange} />,
      );
    });

    await pasteImage();
    expect(textarea().value).toBe("Before upload");
    expect(
      container.querySelector(
        '[data-testid="attachment-composer-upload-error"]',
      )?.textContent,
    ).toBe(
      "The image could not be attached. Your text is still here. Try again.",
    );
    expect(onUploadingChange.mock.calls).toEqual([[true], [false]]);

    await pasteImage();
    expect(backend.saveAsset).toHaveBeenCalledTimes(2);
    expect(textarea().value).toBe(
      "Before upload\n\n![screenshot.png](assets/screenshot.png)",
    );
    expect(
      container.querySelector(
        '[data-testid="attachment-composer-upload-error"]',
      ),
    ).toBeNull();
    expect(onUploadingChange.mock.calls).toEqual([
      [true],
      [false],
      [true],
      [false],
    ]);
  });

  it("explains unavailable remote attachments without saving or changing text", async () => {
    const backend = createBackend("remote");
    const onUploadingChange = vi.fn();
    await act(async () => {
      root.render(
        <Composer backend={backend} onUploadingChange={onUploadingChange} />,
      );
    });

    const { event } = await pasteImage();
    expect(event.defaultPrevented).toBe(true);
    expect(textarea().value).toBe("Before upload");
    expect(backend.saveAsset).not.toHaveBeenCalled();
    expect(onUploadingChange).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="attachment-composer-attach"]'),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="attachment-composer-upload-error"]',
      )?.textContent,
    ).toBe("Image attachments are available in local reviews.");
  });

  it.each([
    "javascript:alert%281%29",
    "data:text/html;base64,PHNjcmlwdD4=",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "file:///etc/passwd",
    "//untrusted.example/image.png",
    "\\\\untrusted.example/image.png",
  ])("renders unsafe image target %s as inert text", async (path) => {
    const backend = createBackend();
    const content = `Text ![Screenshot](${path}) <script>alert(1)</script>`;
    await act(async () => {
      root.render(
        <CommentAssetContext.Provider value={backend}>
          <CommentBody content={content} />
        </CommentAssetContext.Provider>,
      );
    });

    expect(container.textContent).toBe(content);
    expect(container.querySelector('[data-testid="comment-image"]')).toBeNull();
    expect(container.getElementsByTagName("a")).toHaveLength(0);
    expect(container.getElementsByTagName("script")).toHaveLength(0);
    expect(backend.resolveFileUrl).not.toHaveBeenCalled();
  });

  it("rejects an unsafe URL returned by the backend resolver", async () => {
    const backend = createBackend();
    backend.resolveFileUrl.mockReturnValue("javascript:alert(1)");
    const content = "![Screenshot](assets/screenshot.png)";
    await act(async () => {
      root.render(
        <CommentAssetContext.Provider value={backend}>
          <CommentBody content={content} />
        </CommentAssetContext.Provider>,
      );
    });

    expect(container.textContent).toBe(content);
    expect(container.getElementsByTagName("a")).toHaveLength(0);
    expect(container.querySelector('[data-testid="comment-image"]')).toBeNull();
  });
});
