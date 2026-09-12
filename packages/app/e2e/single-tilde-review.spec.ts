import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

test("preserves approximation tildes when saving and reloading a review @smoke", async ({
  page,
}) => {
  const projectDir = createMarkdownProject("single-tilde");
  const prose = "Tracked ~57% of work time (~100h), with ~16 posts.";
  const strikethrough = "Keep ~~removed~~ text.";
  const original = [
    "# Estimate review",
    "",
    prose,
    "",
    strikethrough,
    "",
    "Review this estimate.",
    "",
  ].join("\n");

  try {
    const filePath = writeProjectFile(projectDir, "estimate.md", original);
    await openMarkdownFile(page, filePath, "rich-text");

    const editor = richTextEditor(page);
    await expect(editor).toContainText(prose);
    // The HTML strike element is the formatting contract being protected.
    expect(
      await editor.evaluate((element) =>
        Array.from(
          element.getElementsByTagName("s"),
          (strike) => strike.textContent,
        ),
      ),
    ).toEqual(["removed"]);

    await selectRichText(page, "Review this estimate.");
    await page.getByTestId("selection-menu-action-comment").click();
    await page
      .getByTestId("comment-rail-c1-editor")
      .fill("Confirm the estimate.");
    await page.getByTestId("comment-rail-c1-action-save").click();

    await expect
      .poll(() => readProjectFile(projectDir, "estimate.md"))
      .toContain("Confirm the estimate.");
    const saved = readProjectFile(projectDir, "estimate.md");
    expect(saved).toContain(prose);
    expect(saved).toContain(strikethrough);

    await page.reload();
    await expect(editor).toContainText(prose);
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "Confirm the estimate.",
    );
    expect(
      await editor.evaluate((element) =>
        Array.from(
          element.getElementsByTagName("s"),
          (strike) => strike.textContent,
        ),
      ),
    ).toEqual(["removed"]);
    expect(readProjectFile(projectDir, "estimate.md")).toBe(saved);

    logE2eEvent("markdown.single-tilde-review-save-load", {
      file: "estimate.md",
      preservedApproximationTildes: true,
      preservedDoubleTildeStrikethrough: true,
      savedComment: true,
    });
  } finally {
    removeMarkdownProject(projectDir);
  }
});
