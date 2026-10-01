import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

const plainDocument =
  "# Centered document\n\nA short document without comments.\n";
const commentedDocument =
  '# Reviewed document\n\nThis {==passage==}{>>Please clarify this.<<}{id="c1" by="user" at="2026-04-23T18:00:00.000Z"} has a comment.\n';

test.describe("document sheet layout", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("document-layout");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  for (const width of [320, 390, 768, 1024, 1099, 1440, 2012]) {
    test(`keeps the left tools usable without covering text at ${width}px`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const content = `${plainDocument}\n${"A paragraph long enough to scroll the document.\n\n".repeat(30)}`;
      const filePath = writeProjectFile(projectDir, "scrolling.md", content);
      await request.post("/api/reviews", { data: { documentPath: filePath } });
      await openMarkdownFile(page, filePath);
      const tools = page.getByTestId("document-floating-tools");
      const card = page.getByTestId("document-content-card");
      await expect(tools).toBeVisible();
      await expect(page.getByTestId("revision-history")).toBeVisible();

      for (const mode of ["rich-text", "code"]) {
        const bounds = await tools.boundingBox();
        const sheet = await card.boundingBox();
        if (!bounds || !sheet)
          throw new Error("Document tools or sheet missing.");
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(sheet.x);
        expect(sheet.x + sheet.width).toBeLessThanOrEqual(width);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(width);

        await page.evaluate(() => {
          const scroller = document.querySelector(
            '[data-testid="document-workspace"]',
          );
          scroller?.scrollTo({ top: scroller.scrollHeight });
          window.scrollTo(0, document.documentElement.scrollHeight);
        });
        await expect(tools).toBeInViewport();
        const afterScroll = await tools.boundingBox();
        expect(afterScroll?.y).toBe(bounds.y);
        expect(afterScroll?.x).toBe(bounds.x);
        await page.getByTestId("document-file-menu-trigger").click();
        await expect(page.getByTestId("document-file-menu")).toBeInViewport();
        await page.keyboard.press("Escape");
        logE2eEvent("document-layout.fixed-tools", {
          width,
          mode,
          sheet,
          tools: bounds,
        });

        if (process.env.ROUGHDRAFT_CAPTURE_SCREENSHOTS === "1") {
          await page.evaluate(() => {
            document
              .querySelector('[data-testid="document-workspace"]')
              ?.scrollTo(0, 0);
            window.scrollTo(0, 0);
          });
          const output = path.resolve(
            import.meta.dirname,
            "../../../.context/ui-state-screenshots/document-tools",
          );
          fs.mkdirSync(output, { recursive: true });
          await page.screenshot({
            path: path.join(output, `${width}-${mode}.png`),
          });
        }
        if (mode === "rich-text") {
          await page.getByTestId("document-editor-view-toggle").click();
          await expect(page.getByTestId("markdown-code-editor")).toBeVisible();
        }
      }
    });
  }

  test("centers an uncommented sheet in the viewport @smoke", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const filePath = writeProjectFile(projectDir, "plain.md", plainDocument);
    await openMarkdownFile(page, filePath);

    const card = page.getByTestId("document-content-card");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("document-review-rail")).toBeHidden();
    const box = await card.boundingBox();
    if (!box) throw new Error("The document sheet has no rendered bounds.");
    const leftMargin = box.x;
    const rightMargin = 1440 - box.x - box.width;
    logE2eEvent("document-layout.plain", {
      viewport: 1440,
      box,
      leftMargin,
      rightMargin,
    });

    expect(box.width).toBeGreaterThan(800);
    expect(Math.abs(leftMargin - rightMargin)).toBeLessThanOrEqual(2);
  });

  test("centers an uncommented sheet just below the rail breakpoint @smoke", async ({
    page,
  }) => {
    const viewportWidth = 1024;
    await page.setViewportSize({ width: viewportWidth, height: 900 });
    const filePath = writeProjectFile(
      projectDir,
      "plain-near-breakpoint.md",
      plainDocument,
    );
    await openMarkdownFile(page, filePath);

    const card = page.getByTestId("document-content-card");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("document-review-rail")).toBeHidden();
    const box = await card.boundingBox();
    if (!box) throw new Error("The document sheet has no rendered bounds.");
    const leftMargin = box.x;
    const rightMargin = viewportWidth - box.x - box.width;
    const workspaceBox = await page
      .getByTestId("document-workspace")
      .boundingBox();
    const shellBox = await page
      .getByTestId("document-page-shell")
      .boundingBox();
    const documentScrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    logE2eEvent("document-layout.plain-near-breakpoint", {
      viewport: viewportWidth,
      box,
      leftMargin,
      rightMargin,
      workspaceBox,
      shellBox,
      documentScrollWidth,
    });

    expect(box.width).toBeGreaterThan(800);
    expect(Math.abs(leftMargin - rightMargin)).toBeLessThanOrEqual(2);
  });

  test("keeps a commented sheet and rail visible without horizontal overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const filePath = writeProjectFile(
      projectDir,
      "commented.md",
      commentedDocument,
    );
    await openMarkdownFile(page, filePath);

    const card = page.getByTestId("document-content-card");
    const rail = page.getByTestId("document-review-rail");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("comment-thread-c1")).toBeVisible();
    const cardBox = await card.boundingBox();
    const railBox = await rail.boundingBox();
    if (!cardBox || !railBox) {
      throw new Error("The reviewed document or comment rail has no bounds.");
    }
    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    logE2eEvent("document-layout.commented", {
      viewport: 1440,
      cardBox,
      railBox,
      scrollWidth,
    });

    expect(cardBox.x).toBeGreaterThanOrEqual(0);
    expect(cardBox.x + cardBox.width).toBeLessThan(railBox.x);
    expect(railBox.x + railBox.width).toBeLessThanOrEqual(1440);
    expect(scrollWidth).toBeLessThanOrEqual(1440);
  });

  test("returns the sheet to the viewport center after its last comment is removed", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const filePath = writeProjectFile(
      projectDir,
      "removed-comment.md",
      commentedDocument,
    );
    await openMarkdownFile(page, filePath);
    await page.getByTestId("comment-thread-c1").click();
    await page.getByTestId("comment-rail-c1-action-delete-thread").click();
    await expect(page.getByTestId("document-review-rail")).toBeHidden();

    await expect
      .poll(async () => {
        const box = await page
          .getByTestId("document-content-card")
          .boundingBox();
        if (!box) return Number.POSITIVE_INFINITY;
        return Math.abs(box.x - (1440 - box.x - box.width));
      })
      .toBeLessThanOrEqual(2);
  });
});
