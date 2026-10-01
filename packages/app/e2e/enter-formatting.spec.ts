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

for (const mode of ["suggesting", "editing"] as const) {
  test(`${mode} Enter splits formatted text at the caret and saves formatting @smoke`, async ({
    page,
  }) => {
    const projectDir = createMarkdownProject(`enter-${mode}`);
    try {
      const filePath = writeProjectFile(
        projectDir,
        "enter.md",
        "***Hello world***\n",
      );
      await openMarkdownFile(page, filePath, "rich-text");
      if (mode === "editing") {
        await page.getByTestId("document-mode-trigger").click();
        await page.getByTestId("document-mode-editing").click();
      }
      const editor = richTextEditor(page);
      await selectRichText(page, "Hello");
      await editor.evaluate(() => {
        window.getSelection()?.collapseToEnd();
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      });
      await page.keyboard.press("Enter");
      await page.keyboard.type("Next");
      logE2eEvent("enter-formatting.after-keyboard", {
        mode,
        html: await editor.innerHTML(),
      });
      const paragraphs = editor.locator(":scope > p"); // selector-check-ignore: paragraph splitting is the behavior under test.
      await expect(paragraphs).toHaveCount(2);
      await expect(paragraphs.nth(0)).toHaveText("Hello");
      await expect(paragraphs.nth(1)).toContainText("Next world");
      await expect(
        paragraphs
          .nth(1)
          .locator("strong em, em strong") // selector-check-ignore: bold and italic are the behavior under test.
          .filter({ hasText: "Next" }), // selector-check-ignore: inline formatting is the behavior under test.
      ).toContainText("Next"); // selector-check-ignore: semantic bold and italic formatting is the behavior under test.
      await expect
        .poll(() => readProjectFile(projectDir, "enter.md"))
        .toContain("Next");
      await page.reload();
      await expect(paragraphs).toHaveCount(2);
      await expect(
        paragraphs
          .nth(1)
          .locator("strong em, em strong") // selector-check-ignore: bold and italic are the behavior under test.
          .filter({ hasText: "Next" }), // selector-check-ignore: inline formatting is the behavior under test.
      ).toContainText("Next"); // selector-check-ignore: saved inline formatting must survive reload.
      logE2eEvent("enter-formatting.reopened", {
        mode,
        html: await editor.innerHTML(),
        markdown: readProjectFile(projectDir, "enter.md"),
      });
    } finally {
      removeMarkdownProject(projectDir);
    }
  });
}

test("suggesting Enter creates another formatted list item", async ({
  page,
}) => {
  const projectDir = createMarkdownProject("enter-list");
  try {
    const filePath = writeProjectFile(projectDir, "list.md", "- **First**\n");
    await openMarkdownFile(page, filePath, "rich-text");
    const editor = richTextEditor(page);
    await selectRichText(page, "First");
    await editor.evaluate(() => {
      window.getSelection()?.collapseToEnd();
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    });
    await page.keyboard.press("Enter");
    await page.keyboard.type("Second");
    const items = editor.locator(":scope > ul > li"); // selector-check-ignore: sibling list items are the behavior under test.
    await expect(items).toHaveCount(2);
    await expect(items.nth(1).locator("strong")).toContainText("Second"); // selector-check-ignore: formatting is the behavior under test.
    logE2eEvent("enter-formatting.list", { html: await editor.innerHTML() });
  } finally {
    removeMarkdownProject(projectDir);
  }
});

for (const scenario of [
  "new paragraph",
  "existing paragraph",
  "new list item",
]) {
  test(`suggesting Backspace rejoins ${scenario} and saves formatting`, async ({
    page,
  }) => {
    const projectDir = createMarkdownProject("backspace-join");
    try {
      const source =
        scenario === "existing paragraph"
          ? "**First**\n\n_Second_\n"
          : scenario === "new list item"
            ? "- ***First***\n"
            : "***First***\n";
      const filePath = writeProjectFile(projectDir, "join.md", source);
      await openMarkdownFile(page, filePath, "rich-text");
      const editor = richTextEditor(page);
      if (scenario === "existing paragraph") {
        await selectRichText(page, "Second");
        await editor.evaluate(() => {
          window.getSelection()?.collapseToStart();
          document.dispatchEvent(
            new Event("selectionchange", { bubbles: true }),
          );
        });
      } else {
        await selectRichText(page, "First");
        await editor.evaluate(() => {
          window.getSelection()?.collapseToEnd();
          document.dispatchEvent(
            new Event("selectionchange", { bubbles: true }),
          );
        });
        await page.keyboard.press("Enter");
      }
      logE2eEvent("backspace-join.before", {
        scenario,
        html: await editor.innerHTML(),
      });
      await page.keyboard.press("Backspace");
      if (scenario !== "existing paragraph") await page.keyboard.type("Second");
      logE2eEvent("backspace-join.after", {
        scenario,
        html: await editor.innerHTML(),
      });
      await expect(editor).toContainText("FirstSecond");
      const blocks =
        scenario === "new list item"
          ? editor.locator(":scope > ul > li") // selector-check-ignore: joined list items are the behavior under test.
          : editor.locator(":scope > p"); // selector-check-ignore: joined paragraphs/list items are the behavior under test.
      await expect(blocks).toHaveCount(1);
      if (scenario === "new list item") {
        await expect(blocks.locator(":scope > p")).toHaveCount(1); // selector-check-ignore: list paragraph merging is the behavior under test.
      }
      await expect
        .poll(() => readProjectFile(projectDir, "join.md"))
        .not.toBe(source);
      await page.reload();
      await expect(editor).toContainText("FirstSecond");
      await expect(blocks).toHaveCount(1);
      const bold = editor.locator("strong").filter({ hasText: "First" }); // selector-check-ignore: semantic formatting is the behavior under test.
      await expect(bold).toContainText("First");
      const italic = editor.locator("em").filter({ hasText: "Second" }); // selector-check-ignore: semantic formatting is the behavior under test.
      await expect(italic).toContainText("Second");
      logE2eEvent("backspace-join.reopened", {
        scenario,
        html: await editor.innerHTML(),
        markdown: readProjectFile(projectDir, "join.md"),
      });
    } finally {
      removeMarkdownProject(projectDir);
    }
  });
}
