import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

test("Shift+Enter soft break can be removed with Backspace in suggesting mode", async ({
  page,
}) => {
  const projectDir = createMarkdownProject("soft-break");
  try {
    const filePath = writeProjectFile(
      projectDir,
      "soft-break.md",
      "First line\n",
    );
    await openMarkdownFile(page, filePath);
    const editor = richTextEditor(page);
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+End" : "Control+End",
    );

    await page.keyboard.press("Shift+Enter");
    const afterSoftBreak = await editor.evaluate((element) => ({
      paragraphs: element.querySelectorAll(":scope > p").length, // selector-check-ignore: paragraph structure is the behavior under test.
      breaks: element.querySelectorAll("br:not(.ProseMirror-trailingBreak)") // selector-check-ignore: distinguish a persisted break from the editor caret placeholder.
        .length,
      html: element.innerHTML,
    }));
    logE2eEvent("soft-break.after-shift-enter", afterSoftBreak);
    expect(afterSoftBreak.paragraphs).toBe(1);
    expect(afterSoftBreak.breaks).toBe(1);

    await page.keyboard.press("Backspace");
    await expect(
      editor.locator("br:not(.ProseMirror-trailingBreak)"), // selector-check-ignore: assert the actual break is removed.
    ).toHaveCount(0);
    await expect(editor.locator(":scope > p")).toHaveCount(1); // selector-check-ignore: soft breaks must not create extra paragraphs.
    await expect(editor).toContainText("First line");
  } finally {
    removeMarkdownProject(projectDir);
  }
});

test("saved suggested soft break reopens with its insertion mark", async ({
  page,
}) => {
  const projectDir = createMarkdownProject("saved-soft-break");
  try {
    const filePath = writeProjectFile(
      projectDir,
      "saved-soft-break.md",
      "First line\n",
    );
    await openMarkdownFile(page, filePath);
    const editor = richTextEditor(page);
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+End" : "Control+End",
    );
    await page.keyboard.press("Shift+Enter");

    await expect
      .poll(() => readProjectFile(projectDir, "saved-soft-break.md"))
      .toMatch(/\{\+\+<br>\+\+\}/);
    await page.reload();
    await expect(editor.locator(".critic-change-addition > br")).toHaveCount(1); // selector-check-ignore: the reloaded break must retain its suggestion mark.
    await expect(editor.locator(":scope > p")).toHaveCount(1); // selector-check-ignore: soft breaks must not create extra paragraphs.
  } finally {
    removeMarkdownProject(projectDir);
  }
});

test("editing mode keeps native Shift+Enter and Backspace behavior", async ({
  page,
}) => {
  const projectDir = createMarkdownProject("editing-soft-break");
  try {
    const filePath = writeProjectFile(
      projectDir,
      "editing-soft-break.md",
      "First line\n",
    );
    await openMarkdownFile(page, filePath);
    await page.getByTestId("document-mode-trigger").click();
    await page.getByTestId("document-mode-editing").click();
    const editor = richTextEditor(page);
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+End" : "Control+End",
    );
    await page.keyboard.press("Shift+Enter");

    await expect(
      editor.locator("br:not(.ProseMirror-trailingBreak)"), // selector-check-ignore: count native breaks, excluding the editor caret placeholder.
    ).toHaveCount(1);
    await expect(editor.locator(".critic-change")).toHaveCount(0);
    await page.keyboard.press("Backspace");
    await expect(
      editor.locator("br:not(.ProseMirror-trailingBreak)"), // selector-check-ignore: assert the native break is removed.
    ).toHaveCount(0);
  } finally {
    removeMarkdownProject(projectDir);
  }
});
