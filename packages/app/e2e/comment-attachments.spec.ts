import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

// A real PNG travels through Chromium's clipboard, HTTP, and local storage.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGOwi+8hCTGMahjVMHw1AACXqikQe8MOXAAAAABJRU5ErkJggg==",
  "base64",
);

test.describe("Comment screenshots", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("comment-screenshots");
  });

  test.afterEach(() => removeMarkdownProject(projectDir));

  async function openFixture(page: import("@playwright/test").Page) {
    const file = writeProjectFile(
      projectDir,
      "review.md",
      "# Screenshot review\n\nCheck {==this layout==}{>>Please check spacing.<<}{#c1}\n\n---\ncomments:\n  c1:\n    by: user\n",
    );
    await openMarkdownFile(page, file);
    await page.getByTestId("comment-thread-c1").click();
    return file;
  }

  for (const embedded of [false, true]) {
    test(`pastes a screenshot and preserves a reply after reload (${embedded ? "embedded" : "standard"}) @smoke`, async ({
      page,
      context,
    }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.setViewportSize({ width: 1440, height: 900 });
      await openFixture(page);
      if (embedded) {
        const url = new URL(page.url());
        url.searchParams.set("embed", "1");
        await page.goto(url.toString());
        await page.setViewportSize({ width: 390, height: 900 });
        await page.getByTestId("comment-thread-c1").click();
      }
      await page.getByTestId("comment-rail-c1-action-edit").click();
      const editor = page.getByTestId("comment-rail-c1-editor");
      await editor.fill("Screenshot of the spacing:");
      await editor.press("End");
      await page.evaluate(async (base64) => {
        const data = Uint8Array.from(atob(base64), (char) =>
          char.charCodeAt(0),
        );
        await navigator.clipboard.write([
          new ClipboardItem({
            "image/png": new Blob([data], { type: "image/png" }),
          }),
        ]);
      }, png.toString("base64"));
      await editor.press(
        process.platform === "darwin" ? "Meta+V" : "Control+V",
      );
      await expect(editor).toHaveValue(/!\[.*\]\(\.\/.roughdraft-assets\//);
      logE2eEvent("comment-screenshot.clipboard-uploaded", { embedded });
      await page.getByTestId("comment-rail-c1-action-save").click();
      await expect
        .poll(() => readProjectFile(projectDir, "review.md"))
        .toContain(".roughdraft-assets/");
      const rootImage = page
        .getByTestId("comment-rail-c1")
        .getByTestId("comment-image");
      await expect(rootImage).toBeVisible();
      await expect
        .poll(() =>
          rootImage.evaluate((node: HTMLImageElement) => node.naturalWidth),
        )
        .toBeGreaterThan(0);
      const assetPath = await rootImage.getAttribute("data-markdown-src");
      if (!assetPath) throw new Error("Screenshot has no portable asset path");
      expect(
        fs.readFileSync(path.join(projectDir, assetPath)).subarray(0, 8),
      ).toEqual(png.subarray(0, 8));

      await page.getByTestId("comment-rail-c1-action-reply").click();
      await page
        .getByTestId("comment-rail-c2-editor")
        .fill("Same issue on mobile.");
      await page
        .getByTestId("comment-rail-c2-editor-file-input")
        .setInputFiles({
          name: "mobile-spacing.png",
          mimeType: "image/png",
          buffer: png,
        });
      await expect(page.getByTestId("comment-rail-c2-editor")).toHaveValue(
        /mobile-spacing/,
      );
      await page.getByTestId("comment-rail-c2-action-save").click();
      await expect
        .poll(() => readProjectFile(projectDir, "review.md"))
        .toContain("mobile-spacing.png");
      await page.reload();
      await page.getByTestId("comment-thread-c1").click();
      await expect(
        page.getByTestId("comment-rail-c1").getByTestId("comment-image"),
      ).toHaveCount(2);
      await expect(
        page.getByTestId("comment-rail-c2").getByTestId("comment-image"),
      ).toBeVisible();
      const saved = readProjectFile(projectDir, "review.md");
      expect(saved).toContain("re: c1");
      expect(saved).not.toContain("data:image/");
      if (process.env.ROUGHDRAFT_CAPTURE_SCREENSHOTS === "1") {
        for (const theme of ["light", "dark"]) {
          await page.getByTestId("theme-menu-trigger").click();
          await page.getByTestId(`theme-option-${theme}`).click();
          await page.getByTestId("comment-thread-c1").click();
          await page.getByTestId("comment-rail-c1-action-edit").click();
          await page
            .getByTestId("comment-rail-c1-editor-attach")
            .scrollIntoViewIfNeeded();
          await page.screenshot({
            path: path.resolve(
              import.meta.dirname,
              "../../../.context/ui-state-screenshots",
              `comment-screenshots-${embedded ? "narrow" : "desktop"}-${theme}.png`,
            ),
          });
          await page.getByTestId("comment-rail-c1-action-cancel").click();
        }
      }
      logE2eEvent("comment-screenshot.roundtrip", {
        embedded,
        storedAsset: assetPath,
        replyPersisted: true,
      });
    });
  }

  test("keeps text on upload failure and allows retry and removal", async ({
    page,
  }) => {
    await openFixture(page);
    await page.getByTestId("comment-rail-c1-action-edit").click();
    const editor = page.getByTestId("comment-rail-c1-editor");
    await editor.fill("Keep this feedback.");
    await page.route(/\/api\/assets(?:\?|$)/, (route) =>
      route.fulfill({ status: 500, body: "Upload failed" }),
    );
    const picker = page.getByTestId("comment-rail-c1-editor-file-input");
    await picker.setInputFiles({
      name: "retry.png",
      mimeType: "image/png",
      buffer: png,
    });
    await expect(
      page.getByTestId("comment-rail-c1-editor-upload-error"),
    ).toBeVisible();
    await expect(editor).toHaveValue("Keep this feedback.");
    await page.unroute(/\/api\/assets(?:\?|$)/);
    await picker.setInputFiles({
      name: "retry.png",
      mimeType: "image/png",
      buffer: png,
    });
    await expect(editor).toHaveValue(/retry.png/);
    await page.getByTestId("comment-image-remove").click();
    await expect(editor).not.toHaveValue(/retry.png/);
    await expect(editor).toHaveValue(/Keep this feedback/);
    logE2eEvent("comment-screenshot.failure-retry-remove", {
      textPreserved: true,
    });
  });

  test("saves an overall handoff screenshot in the Markdown file", async ({
    page,
  }) => {
    await openFixture(page);
    await page.getByTestId("review-handoff-comment-trigger").click();
    const editor = page.getByTestId("review-handoff-overall-comment");
    await editor.fill("Review this screenshot.");
    await page
      .getByTestId("review-handoff-overall-comment-file-input")
      .setInputFiles({
        name: "overall.png",
        mimeType: "image/png",
        buffer: png,
      });
    await expect(editor).toHaveValue(/overall.png/);
    await page.getByTestId("review-handoff-submit-comment").click();
    await expect
      .poll(() => readProjectFile(projectDir, "review.md"))
      .toContain("overall.png");
    await page.reload();
    await expect(page.getByTestId("comment-image")).toBeVisible();
    logE2eEvent("comment-screenshot.handoff-preserved");
  });
});
