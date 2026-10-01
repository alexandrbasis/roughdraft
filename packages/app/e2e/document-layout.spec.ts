import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

const plainDocument =
  "# Document layout\n\nA paragraph in the reading column.\n";

async function expectSeparatedColumns(page: Page, viewportWidth: number) {
  const tools = page.getByTestId("document-floating-tools");
  const outline = page.getByTestId("document-outline-sidebar");
  const sheet = page.getByTestId("document-content-card");
  await expect(tools).toBeVisible();
  await expect(outline).toBeVisible();
  await expect(sheet).toBeVisible();
  expect(await page.evaluate(() => window.innerWidth)).toBe(viewportWidth);

  const toolBox = await tools.boundingBox();
  const outlineBox = await outline.boundingBox();
  const sheetBox = await sheet.boundingBox();
  if (!toolBox || !outlineBox || !sheetBox)
    throw new Error("Tools, outline, or document sheet lacks visible bounds");
  expect(toolBox.x).toBeGreaterThanOrEqual(0);
  expect(toolBox.x).toBeLessThanOrEqual(16);
  expect(toolBox.width).toBeLessThanOrEqual(60);
  expect(toolBox.x + toolBox.width).toBeLessThanOrEqual(outlineBox.x + 1);
  expect(outlineBox.x + outlineBox.width).toBeLessThanOrEqual(sheetBox.x + 1);
  expect(sheetBox.x + sheetBox.width).toBeLessThanOrEqual(viewportWidth);
  expect(sheetBox.width).toBeGreaterThanOrEqual(
    Math.min(150, viewportWidth * 0.35),
  );
  if (viewportWidth <= 390) {
    const workspaceBox = await page
      .getByTestId("document-workspace")
      .boundingBox();
    const approveBox = await page
      .getByTestId("review-handoff-split-button")
      .boundingBox();
    if (!workspaceBox || !approveBox)
      throw new Error("Document scroll area or Approve control lacks bounds");
    expect(workspaceBox.y).toBeGreaterThanOrEqual(
      approveBox.y + approveBox.height,
    );
  }
  if (viewportWidth < 640) {
    expect(outlineBox.width).toBeGreaterThanOrEqual(96);
    expect(outlineBox.width).toBeLessThanOrEqual(160);
  } else {
    expect(outlineBox.width).toBeGreaterThanOrEqual(190);
    expect(outlineBox.width).toBeLessThanOrEqual(230);
  }

  // The sheet centers within the space after the outline, not the whole window.
  const leftSpace = sheetBox.x - outlineBox.x - outlineBox.width;
  const rightSpace = viewportWidth - sheetBox.x - sheetBox.width;
  expect(Math.abs(leftSpace - rightSpace)).toBeLessThanOrEqual(24);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(viewportWidth);
  logE2eEvent("document-layout.persistent-columns", {
    viewportWidth,
    tools: toolBox,
    outline: outlineBox,
    sheet: sheetBox,
    leftSpace,
    rightSpace,
  });
  return { tools, outline, toolBox, outlineBox };
}

test.describe("document sheet with persistent outline", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("document-layout");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  for (const width of [320, 390, 768, 1024, 1440, 2012]) {
    test(`keeps tools, outline, and document separate at ${width}px${width === 320 || width === 1440 ? " @smoke" : ""}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const documentPath = writeProjectFile(
        projectDir,
        "scrolling.md",
        `${plainDocument}\n${"A paragraph long enough to scroll the document.\n\n".repeat(30)}`,
      );
      await openMarkdownFile(page, documentPath);
      const { tools, outline, toolBox, outlineBox } =
        await expectSeparatedColumns(page, width);

      await page
        .getByTestId("document-workspace")
        .evaluate((element) => element.scrollTo(0, element.scrollHeight));
      await expect(tools).toBeInViewport();
      await expect(outline).toBeInViewport();
      const toolsAfterScroll = await tools.boundingBox();
      const outlineAfterScroll = await outline.boundingBox();
      expect(toolsAfterScroll?.x).toBe(toolBox.x);
      expect(toolsAfterScroll?.y).toBe(toolBox.y);
      expect(outlineAfterScroll?.x).toBe(outlineBox.x);
      expect(outlineAfterScroll?.y).toBe(outlineBox.y);

      if (width === 320) {
        await page.getByTestId("document-file-menu-trigger").click();
        await expect(page.getByTestId("document-file-menu")).toBeInViewport();
        await page.keyboard.press("Escape");
      }
      if (width === 390) {
        await page.getByTestId("document-editor-view-toggle").click();
        await expect(page.getByTestId("markdown-code-editor")).toBeVisible();
        await expectSeparatedColumns(page, width);
      }
      if (process.env.ROUGHDRAFT_CAPTURE_SCREENSHOTS === "1") {
        await page
          .getByTestId("document-workspace")
          .evaluate((element) => element.scrollTo(0, 0));
        const directory = path.resolve(
          import.meta.dirname,
          "../../../.context/ui-state-screenshots/document-outline",
        );
        fs.mkdirSync(directory, { recursive: true });
        await page.screenshot({
          path: path.join(directory, `columns-${width}.png`),
          animations: "disabled",
        });
      }
    });
  }
});
