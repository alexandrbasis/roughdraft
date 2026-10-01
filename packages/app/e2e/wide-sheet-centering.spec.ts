import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test("centers the sheet on a wide screen even when a lower comment reserves a rail @smoke", async ({
  page,
}) => {
  const projectDir = createMarkdownProject("wide-sheet-centering");
  try {
    const viewportWidth = 2012;
    await page.setViewportSize({ width: viewportWidth, height: 1071 });
    const filePath = writeProjectFile(
      projectDir,
      "long-reviewed-document.md",
      [
        "# Long reviewed document",
        ...Array.from(
          { length: 24 },
          (_, index) =>
            `\nParagraph ${index + 1} keeps the comment below the fold.`,
        ),
        '\nThe final {==passage==}{>>Please clarify this.<<}{id="c1" by="user" at="2026-04-23T18:00:00.000Z"} has a comment.',
        "",
      ].join("\n"),
    );
    await openMarkdownFile(page, filePath);

    const sheet = page.getByTestId("document-content-card");
    const rail = page.getByTestId("document-review-rail");
    await expect(sheet).toBeVisible();
    await expect(rail).toBeVisible();
    const sheetBox = await sheet.boundingBox();
    const railBox = await rail.boundingBox();
    if (!sheetBox || !railBox) {
      throw new Error(
        "The document sheet or comment rail has no rendered bounds.",
      );
    }

    const leftMargin = sheetBox.x;
    const rightMargin = viewportWidth - sheetBox.x - sheetBox.width;
    logE2eEvent("wide-sheet-centering.with-lower-comment", {
      viewport: viewportWidth,
      sheetBox,
      railBox,
      leftMargin,
      rightMargin,
    });

    expect(sheetBox.width).toBeGreaterThan(800);
    expect(Math.abs(leftMargin - rightMargin)).toBeLessThanOrEqual(2);
    expect(sheetBox.x + sheetBox.width).toBeLessThan(railBox.x);
    expect(railBox.x + railBox.width).toBeLessThanOrEqual(viewportWidth);
  } finally {
    removeMarkdownProject(projectDir);
  }
});
