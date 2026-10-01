import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test.describe("floating revision legend", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("revision-legend");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 600 },
  ]) {
    test(`shows five versions outside the text at ${viewport.width}px`, async ({
      page,
      request,
    }) => {
      const paragraph = "A paragraph long enough to scroll the document.";
      const body = `${paragraph}\n\n`.repeat(35);
      const documentPath = writeProjectFile(
        projectDir,
        "review.md",
        `# Review\n\n${body}`,
      );
      for (let version = 1; version <= 5; version += 1) {
        if (version > 1) {
          writeProjectFile(
            projectDir,
            "review.md",
            `# Review\n\n${Array.from({ length: version - 1 }, (_, index) => `Version ${index + 2} added a sentence.\n\n`).join("")}${body}`,
          );
        }
        const response = await request.post("/api/reviews", {
          data: { documentPath },
        });
        expect(response.status()).toBe(201);
      }

      await page.setViewportSize(viewport);
      await openMarkdownFile(page, documentPath);
      const rail = page.getByTestId("document-floating-rail");
      const tools = page.getByTestId("document-floating-tools");
      const legend = page.getByTestId("revision-legend");
      const editor = page.getByTestId("rich-text-editor");
      await expect(tools).toBeVisible();
      await expect(page.getByTestId("revision-highlight")).toHaveCount(4);

      logE2eEvent("revision-legend.before-assertion", {
        viewport,
        legendCount: await legend.count(),
        editorMarkerCount: await editor
          .getByTestId("revision-change-marker")
          .count(),
        tools: await tools.boundingBox(),
      });

      await expect(legend).toBeVisible();
      await expect(rail).toBeVisible();
      for (let version = 1; version <= 5; version += 1) {
        const badge = legend.getByTestId(`revision-legend-version-${version}`);
        await expect(badge).toHaveCount(1);
        await expect(badge).toHaveText(`V${version}`);
        if (version > 1) {
          const highlight = page
            .getByTestId("revision-highlight")
            .filter({ hasText: `Version ${version} added a sentence.` });
          await expect(highlight).toBeVisible();
          const colorClass = (await highlight.getAttribute("class"))
            ?.split(/\s+/)
            .find((name) => name.startsWith("revision-color-"));
          expect(colorClass).toBeTruthy();
          await expect(badge).toHaveClass(new RegExp(`\\b${colorClass}\\b`));
        }
      }
      await expect(editor.getByTestId("revision-change-marker")).toHaveCount(0);
      await expect(editor).not.toContainText(/\bV[1-5]\b/);

      const toolsBox = await tools.boundingBox();
      const legendBox = await legend.boundingBox();
      const sheetBox = await page
        .getByTestId("document-content-card")
        .boundingBox();
      if (!toolsBox || !legendBox || !sheetBox) {
        throw new Error(
          "Floating tools, legend, or document sheet lacks bounds",
        );
      }
      expect(legendBox.y).toBeGreaterThanOrEqual(toolsBox.y + toolsBox.height);
      expect(legendBox.x + legendBox.width).toBeLessThanOrEqual(sheetBox.x);
      const railBox = await rail.boundingBox();
      if (!railBox) throw new Error("Floating rail lacks bounds");
      expect(railBox.y + railBox.height).toBeLessThanOrEqual(viewport.height);

      await page.evaluate(() => {
        document
          .querySelector('[data-testid="document-workspace"]')
          ?.scrollTo(0, 1000);
        window.scrollTo(0, 1000);
      });
      await expect(legend).toBeInViewport();
      const afterScroll = await legend.boundingBox();
      expect(afterScroll?.x).toBe(legendBox.x);
      expect(afterScroll?.y).toBe(legendBox.y);

      // Short windows scroll the fixed column instead of clipping later versions.
      const lastBadge = legend.getByTestId("revision-legend-version-5");
      await lastBadge.focus();
      await expect(lastBadge).toBeInViewport({ ratio: 1 });
      await expect(
        page
          .locator('[data-slot="tooltip-content"]:visible') // selector-check-ignore: The shared shadcn Tooltip portal exposes generic content rather than role=tooltip.
          .filter({ hasText: "V5 · Agent" }),
      ).toContainText("Completed");
      const firstBadge = legend.getByTestId("revision-legend-version-1");
      await firstBadge.focus();
      await expect(firstBadge).toBeInViewport({ ratio: 1 });
      await expect(
        page
          .locator('[data-slot="tooltip-content"]:visible') // selector-check-ignore: Observe the shared Tooltip portal after keyboard focus moves to V1.
          .filter({ hasText: "V1 · Agent" }),
      ).toContainText("Completed");
      logE2eEvent("revision-legend.geometry-and-count", {
        viewport,
        versions: 5,
        tools: toolsBox,
        legend: legendBox,
        afterScroll,
        sheet: sheetBox,
        columnScroll: await rail.evaluate((element) => ({
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        })),
      });

      // Even an unchanged completed review gets its own version in the legend.
      await page.getByTestId("review-handoff-button").click();
      await expect(legend.getByTestId("revision-legend-version-6")).toHaveText(
        "V6",
      );
      await expect(legend.getByRole("listitem")).toHaveCount(6);
      await expect(editor.getByTestId("revision-change-marker")).toHaveCount(0);
      logE2eEvent("revision-legend.completed-version-appended", {
        viewport,
        versions: 6,
      });
    });
  }
});
