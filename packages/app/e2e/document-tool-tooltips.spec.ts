import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  openMarkdownFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test.describe("document tooltips", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("document-tool-tooltips");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("explains each floating document tool on hover", async ({ page }) => {
    const filePath = writeProjectFile(
      projectDir,
      "tooltip-document.md",
      "# Tooltip document\n\nA document for checking the floating tools.\n",
    );
    await openMarkdownFile(page, filePath);

    const tools = [
      {
        id: "document-editor-view-toggle",
        explanation: "Switch to code view. Edit the Markdown source directly.",
      },
      {
        id: "document-file-menu-trigger",
        explanation: "Copy the path, filename, Markdown, or rich text.",
      },
      {
        id: "document-mode-trigger",
        explanation:
          "Choose how to work with this document. Editing changes text; Suggesting records proposals; Viewing prevents edits.",
      },
      {
        id: "revision-history",
        explanation:
          "Preview completed versions and recovery copies. Restore into your current work.",
      },
      {
        id: "revision-filter",
        explanation:
          "Choose which completed versions' changes appear. The document stays unchanged. 0 changes.",
      },
      {
        id: "revision-prev",
        explanation: "No highlighted changes to navigate.",
      },
      {
        id: "revision-next",
        explanation: "No highlighted changes to navigate.",
      },
      {
        id: "revision-details",
        explanation: "Select a highlighted change to compare before and after.",
      },
      {
        id: "revision-toggle",
        explanation:
          "Hide version highlights. The document and saved versions stay unchanged.",
      },
    ];

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const { id, explanation } of tools) {
        const tool = page.getByTestId(id);
        await expect(
          tool,
          `${id} should be visible at ${width}px`,
        ).toBeVisible();
        await tool.hover();
        const matchingTooltip = page
          .locator('[data-slot="tooltip-content"]:visible') // selector-check-ignore: Tooltip portals are shared by all floating controls.
          .filter({ hasText: explanation })
          .last();
        await expect(
          matchingTooltip,
          `${id} should explain itself at ${width}px`,
        ).toHaveText(explanation);
      }
    }

    for (const id of [
      "document-file-menu-trigger",
      "document-mode-trigger",
      "revision-prev",
      "revision-details",
    ]) {
      await page.mouse.move(0, 0);
      const tool = page.getByTestId(id);
      await tool.focus();
      const explanation = tools.find((item) => item.id === id)?.explanation;
      if (!explanation)
        throw new Error(`Missing tooltip expectation for ${id}`);
      await expect(
        page
          .locator('[data-slot="tooltip-content"]:visible') // selector-check-ignore: Check the visible shared Tooltip portal on focus.
          .filter({ hasText: explanation })
          .last(),
        `${id} should explain itself on keyboard focus`,
      ).toHaveText(explanation);
    }

    await page.getByTestId("document-file-menu-trigger").click();
    await expect(page.getByTestId("document-file-menu")).toBeVisible();
    await expect(
      page
        .locator('[data-slot="tooltip-content"]:visible') // selector-check-ignore: No shared Tooltip portal should remain over its menu.
        .filter({
          hasText: "Copy the path, filename, Markdown, or rich text.",
        }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");

    await page.getByTestId("document-mode-trigger").click();
    await expect(page.locator('[data-slot="select-content"]')).toBeVisible(); // selector-check-ignore: The shadcn Select portal opening is the behavior under test.
    await expect(
      page
        .locator('[data-slot="tooltip-content"]:visible') // selector-check-ignore: No shared Tooltip portal should remain open over the mode list.
        .filter({ hasText: "Editing changes text" }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");

    await page.getByTestId("revision-filter").click();
    await expect(page.getByTestId("revision-filter-popover")).toBeVisible();
    await expect(
      page
        .locator('[data-slot="tooltip-content"]:visible') // selector-check-ignore: No shared Tooltip portal should remain open over the filter.
        .filter({ hasText: "Choose which completed versions" }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");

    await page.getByTestId("revision-history").click();
    await expect(page.getByTestId("revision-history-dialog")).toBeVisible();
    await expect(
      page
        .locator('[data-slot="tooltip-content"]:visible') // selector-check-ignore: No shared Tooltip portal should remain open over History.
        .filter({ hasText: "Preview completed versions" }),
    ).toHaveCount(0);
  });
});
