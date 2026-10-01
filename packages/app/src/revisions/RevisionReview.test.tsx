import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RevisionReview } from "./RevisionReview";
import type { DocumentRevision } from "./types";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

async function click(testId: string) {
  const button = document.querySelector(`[data-testid='${testId}']`);
  expect(button, testId).not.toBeNull();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function historyPreview() {
  const preview = document.querySelector(
    "[data-testid='revision-history-preview']",
  );
  if (!preview) throw new Error("History preview is missing");
  return preview;
}

async function openHistory(contents: string[]) {
  const revisions: DocumentRevision[] = contents.map((content, index) => ({
    id: `r${index + 1}`,
    number: index + 1,
    content,
    version: `v${index + 1}`,
    source: index ? "external" : "baseline",
    createdAt: "2026-10-01T10:00:00Z",
    completedAt: index ? "2026-10-01T10:00:00Z" : null,
    actor: index ? "agent" : "unknown",
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ revisions, recoveryPoints: [] }),
    }),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <RevisionReview
        documentPath="/tmp/history.md"
        markdown={contents.at(-1) ?? ""}
        refreshKey="v"
        editor={null}
        legendContainer={null}
      />,
    );
  });
  await click("revision-history");
}

it("colors every selected version change against its predecessor, including replaced and deleted text", async () => {
  await openHistory([
    "A red cat.\n\nRemoved paragraph.",
    "A green cat.",
    "A blue cat.",
  ]);
  await click("revision-history-2");
  const preview = historyPreview();
  expect(
    preview.querySelector("[data-testid='revision-highlight']")?.textContent,
  ).toBe("green");
  expect(
    preview
      .querySelector("[data-testid='revision-highlight']")
      ?.classList.contains("revision-color-1"),
  ).toBe(true);
  const deleted = [
    ...preview.querySelectorAll("[data-testid='revision-deletion'] del"),
  ]
    .map((node) => node.textContent)
    .join("");
  expect(deleted).toContain("red");
  expect(deleted).toContain("Removed paragraph.");
  expect(preview.textContent).not.toContain("blue");
});

it("colors formatting-only changes in the selected version preview", async () => {
  await openHistory(["Title\n\nplain", "# Title\n\n**plain**"]);
  const preview = historyPreview();
  const highlighted = [
    ...preview.querySelectorAll("[data-testid='revision-highlight']"),
  ]
    .map((node) => node.textContent)
    .join("");
  expect(highlighted).toContain("Title");
  expect(highlighted).toContain("plain");
  expect(
    preview.querySelector("[data-testid='revision-structure-change']")
      ?.textContent,
  ).toBe("Paragraph → Heading 1");
});

it("shows an empty changed block rather than hiding a whitespace-only transition", async () => {
  await openHistory(["```\n\n```", ""]);
  const preview = historyPreview();
  expect(
    preview.querySelector("[data-testid='revision-structure-change']")
      ?.textContent,
  ).toBe("Code block → Paragraph");
});
