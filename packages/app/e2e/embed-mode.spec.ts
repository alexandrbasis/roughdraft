import { expect, test } from "@playwright/test";
import {
  appendInCodeEditor,
  createMarkdownProject,
  logE2eEvent,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test.describe("embedded review", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("embed");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  for (const width of [380, 720]) {
    test(`uses panel width at ${width}px in both editor modes`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({
        colorScheme: width === 380 ? "dark" : "light",
      });
      const original =
        "# Panel review\n\nA document in a narrow workspace panel.\n";
      const filePath = writeProjectFile(projectDir, "panel.md", original);
      const params = new URLSearchParams({ path: filePath });

      await page.goto(`/?${params}`);
      const card = page.getByTestId("document-content-card");
      await expect(card).toBeVisible();
      const normalBounds = await card.boundingBox();
      expect(normalBounds?.x).toBeGreaterThanOrEqual(30);

      params.set("embed", "1");
      await page.goto(`/?${params}`);
      await expect(card).toBeVisible();
      for (const mode of ["rich-text", "code"]) {
        const bounds = await card.boundingBox();
        expect(bounds?.x).toBe(0);
        expect(bounds?.width).toBeGreaterThanOrEqual(width - 20);
        await expect(card).toHaveCSS("box-shadow", "none");
        await expect(card).toHaveCSS("border-radius", "0px");
        await expect(
          page.getByTestId("document-file-menu-trigger"),
        ).toBeVisible();
        await expect(page.getByTestId("document-mode-trigger")).toBeVisible();
        logE2eEvent("embed.layout", { width, mode, bounds });
        await page.screenshot({
          path: testInfo.outputPath(`embed-${width}-${mode}.png`),
        });
        if (mode === "rich-text") {
          await page.getByTestId("document-editor-view-toggle").click();
          await expect(page.getByTestId("markdown-code-editor")).toBeVisible();
          expect(new URL(page.url()).searchParams.get("embed")).toBe("1");
        }
      }
      expect(readProjectFile(projectDir, "panel.md")).toBe(original);
      await appendInCodeEditor(page, "\nSaved in the panel.\n");
      await expect
        .poll(() => readProjectFile(projectDir, "panel.md"))
        .toContain("Saved in the panel.");
    });
  }

  test("delivers completion and saves feedback in an embedded panel @smoke", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 480, height: 800 });
    const filePath = writeProjectFile(
      projectDir,
      "handoff.md",
      "# Embedded handoff\n\nReady to review.\n",
    );
    const pendingWatch = request.post("/api/review-events/watch", {
      data: { projectPath: projectDir, path: "handoff.md", timeoutSeconds: 15 },
    });
    try {
      await page.goto(
        `/?${new URLSearchParams({ path: filePath, embed: "1" })}`,
      );
      await expect(page.getByTestId("review-handoff-button")).toBeVisible();
      await page.getByTestId("review-handoff-comment-trigger").click();
      await page
        .getByTestId("review-handoff-overall-comment")
        .fill("Panel review completed.");
      await page.getByTestId("review-handoff-button").click();
      const response = await pendingWatch;
      expect(response.ok()).toBe(true);
      const payload = await response.json();
      expect(payload.events).toHaveLength(1);
      expect(payload.events[0].overallComment).toBe("Panel review completed.");
      expect(readProjectFile(projectDir, "handoff.md")).toContain(
        "Panel review completed.",
      );
      logE2eEvent("embed.handoff", { event: payload.events[0].type });
    } finally {
      await pendingWatch;
    }
  });
});
