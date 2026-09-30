import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  documentSaveStatus,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

// The generated Markdown list hierarchy is the behavior under test.
// These selectors are scoped to the rich-text editor's test ID.
const scenarios = [
  {
    name: "three numbered levels",
    source: "1. Parent\n   1. Child\n      1. Grandchild\n",
    childList: ":scope > ol > li > ol",
    grandchildList: ":scope > ol > li > ol > li > ol",
  },
  {
    name: "numbered and bulleted levels",
    source: "1. Parent\n   - Child\n     1. Grandchild\n",
    childList: ":scope > ol > li > ul",
    grandchildList: ":scope > ol > li > ul > li > ol",
  },
  {
    name: "a multi-digit numbered parent",
    source: "9. First sibling\n10. Parent\n    - Child\n      1. Grandchild\n",
    childList: ":scope > ol > li > ul",
    grandchildList: ":scope > ol > li > ul > li > ol",
  },
];

test.describe("nested list file round-trips", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("nested-lists");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  for (const scenario of scenarios) {
    test(`preserves ${scenario.name} after editing, saving, and reopening @smoke`, async ({
      page,
    }) => {
      const filePath = writeProjectFile(
        projectDir,
        "nested-lists.md",
        scenario.source,
      );

      await openMarkdownFile(page, filePath, "rich-text");
      const editor = richTextEditor(page);
      await expect(editor.locator(scenario.childList)).toHaveCount(1);
      await expect(editor.locator(scenario.grandchildList)).toContainText(
        "Grandchild",
      );
      logE2eEvent("nested-lists.loaded", { scenario: scenario.name });

      await selectRichText(page, "Child");
      await page.keyboard.type("Edited child");
      await expect
        .poll(() => readProjectFile(projectDir, "nested-lists.md"))
        .toContain("Edited child");
      await expect(documentSaveStatus(page)).toHaveAttribute(
        "aria-label",
        "Saved",
      );
      logE2eEvent("nested-lists.saved", {
        scenario: scenario.name,
        markdown: readProjectFile(projectDir, "nested-lists.md"),
      });

      await page.reload();
      await expect(editor.locator(scenario.childList)).toHaveCount(1);
      await expect(editor.locator(scenario.childList)).toContainText(
        "Edited child",
      );
      await expect(editor.locator(scenario.grandchildList)).toContainText(
        "Grandchild",
      );
      if (scenario.name === "a multi-digit numbered parent") {
        const rootList = editor.locator(":scope > ol"); // selector-check-ignore
        const siblings = rootList.locator(":scope > li"); // selector-check-ignore
        await expect(rootList).toHaveAttribute("start", "9");
        await expect(siblings).toHaveCount(2);
      }
      logE2eEvent("nested-lists.reopened", { scenario: scenario.name });
    });
  }
});
