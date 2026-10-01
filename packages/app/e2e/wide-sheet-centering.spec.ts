import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test("centers the sheet and lower comment rail in the document pane on a wide screen @smoke", async ({
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
    const workspace = page.getByTestId("document-workspace");
    await expect(sheet).toBeVisible();
    await expect(rail).toBeVisible();
    const sheetBox = await sheet.boundingBox();
    const railBox = await rail.boundingBox();
    const workspaceBox = await workspace.boundingBox();
    if (!sheetBox || !railBox || !workspaceBox) {
      throw new Error(
        "The document pane, sheet, or comment rail has no rendered bounds.",
      );
    }

    const compositionLeft = sheetBox.x;
    const compositionRight = railBox.x + railBox.width;
    const compositionCenter = (compositionLeft + compositionRight) / 2;
    const paneCenter = workspaceBox.x + workspaceBox.width / 2;
    logE2eEvent("wide-sheet-centering.with-lower-comment", {
      viewport: viewportWidth,
      workspaceBox,
      sheetBox,
      railBox,
      compositionCenter,
      paneCenter,
    });

    expect(sheetBox.width).toBeGreaterThan(800);
    expect(sheetBox.width).toBeLessThanOrEqual(898);
    expect(railBox.width).toBeGreaterThanOrEqual(280);
    expect(railBox.width).toBeLessThanOrEqual(296);
    const railGap = railBox.x - sheetBox.x - sheetBox.width;
    expect(railGap).toBeGreaterThanOrEqual(22);
    expect(railGap).toBeLessThanOrEqual(26);
    expect(Math.abs(compositionCenter - paneCenter)).toBeLessThanOrEqual(2);
    expect(compositionLeft).toBeGreaterThanOrEqual(workspaceBox.x);
    expect(compositionRight).toBeLessThanOrEqual(
      workspaceBox.x + workspaceBox.width,
    );
  } finally {
    removeMarkdownProject(projectDir);
  }
});
