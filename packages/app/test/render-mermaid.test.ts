import { beforeEach, describe, expect, it, vi } from "vitest";

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({ default: mermaidMocks }));

import {
  renderMermaidDiagram,
  resetMermaidRenderStateForTests,
} from "../src/render-mermaid";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("renderMermaidDiagram", () => {
  beforeEach(() => {
    mermaidMocks.initialize.mockReset();
    mermaidMocks.render.mockReset();
    resetMermaidRenderStateForTests();
  });

  it("uses strict Mermaid settings, the requested theme, and unique IDs", async () => {
    mermaidMocks.render.mockResolvedValue({ svg: "<svg />" });

    await renderMermaidDiagram("flowchart LR\nA --> B", "light");
    await renderMermaidDiagram("sequenceDiagram\nA->>B: Hello", "dark");

    expect(mermaidMocks.initialize).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: "default",
        htmlLabels: false,
        secure: expect.arrayContaining([
          "securityLevel",
          "htmlLabels",
          "themeCSS",
        ]),
      }),
    );
    expect(mermaidMocks.initialize).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: "dark",
      }),
    );
    expect(mermaidMocks.render.mock.calls[0]?.[0]).toBe("roughdraft-mermaid-1");
    expect(mermaidMocks.render.mock.calls[1]?.[0]).toBe("roughdraft-mermaid-2");
  });

  it("serializes renders so Mermaid's global theme cannot race", async () => {
    const firstRender = deferred<{ svg: string }>();
    mermaidMocks.render
      .mockReturnValueOnce(firstRender.promise)
      .mockResolvedValueOnce({ svg: '<svg data-result="second" />' });

    const first = renderMermaidDiagram("flowchart LR\nA --> B", "light");
    const second = renderMermaidDiagram("flowchart LR\nA --> C", "dark");

    await vi.waitFor(() =>
      expect(mermaidMocks.render).toHaveBeenCalledTimes(1),
    );
    firstRender.resolve({ svg: '<svg data-result="first" />' });

    await expect(first).resolves.toContain('data-result="first"');
    await expect(second).resolves.toContain('data-result="second"');
    expect(mermaidMocks.render).toHaveBeenCalledTimes(2);
  });

  it("renders the next diagram after an earlier source fails to parse", async () => {
    mermaidMocks.render
      .mockRejectedValueOnce(new Error("Invalid diagram"))
      .mockResolvedValueOnce({ svg: "<svg />" });

    await expect(
      renderMermaidDiagram("flowchart ???", "light"),
    ).rejects.toThrow("Invalid diagram");
    await expect(
      renderMermaidDiagram("flowchart LR\nA --> B", "dark"),
    ).resolves.toContain("<svg ");
  });
  it("makes linked Mermaid output valid XML before displaying it as an inert image", async () => {
    mermaidMocks.render.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="https://example.invalid"><text>Review</text></a></svg>',
    });

    const svg = await renderMermaidDiagram("flowchart LR", "light");
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(parsed.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(parsed.documentElement.getAttribute("xmlns:xlink")).toBe(
      "http://www.w3.org/1999/xlink",
    );
  });

  it("reports invalid generated SVG so the editor can reveal its source", async () => {
    mermaidMocks.render.mockResolvedValue({ svg: "<svg><g></svg>" });
    await expect(renderMermaidDiagram("flowchart LR", "light")).rejects.toThrow(
      "not a valid SVG image",
    );
  });
});
