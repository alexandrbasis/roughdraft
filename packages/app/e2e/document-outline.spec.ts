import fs from "node:fs";
import path from "node:path";
import { expect, type Locator, test } from "@playwright/test";
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

function entry(outline: Locator, title: string) {
  return outline.getByRole("button", { name: title, exact: true });
}

const filler = "A paragraph that gives the document enough room to scroll.\n\n";

test.describe("document outline", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("outline");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("desktop outline distinguishes repeated headings and targets rich text and source @smoke", async ({
    page,
  }) => {
    const markdown = [
      "# Guide",
      "",
      "## Repeated",
      "",
      filler.repeat(28),
      "## Repeated",
      "",
      "### Third level",
      "",
      "#### Fourth level",
      "",
      "##### Fifth level",
      "",
      "###### Sixth level",
      "",
      "```markdown",
      "# Fenced text is not a heading",
      "```",
      "",
      filler.repeat(8),
    ].join("\n");
    const documentPath = writeProjectFile(projectDir, "guide.md", markdown);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openMarkdownFile(page, documentPath);

    const sidebar = page.getByTestId("document-outline-sidebar");
    const outline = sidebar.getByTestId("document-outline-navigation");
    await expect(sidebar).toBeVisible();
    await expect(outline).toHaveAttribute("aria-label", "Document outline");
    await expect(outline.getByTestId("document-outline-entry")).toHaveCount(7);
    await expect(entry(outline, "Repeated")).toHaveCount(2);
    await expect(entry(outline, "Fenced text is not a heading")).toHaveCount(0);
    for (const [title, level] of [
      ["Guide", 1],
      ["Third level", 3],
      ["Fourth level", 4],
      ["Fifth level", 5],
      ["Sixth level", 6],
    ] as const) {
      await expect(entry(outline, title)).toHaveAttribute(
        "data-level",
        String(level),
      );
    }
    await expect(entry(outline, "Repeated").first()).toHaveAttribute(
      "data-level",
      "2",
    );
    const x1 = (await entry(outline, "Guide").boundingBox())?.x;
    const x2 = (await entry(outline, "Repeated").first().boundingBox())?.x;
    const x3 = (await entry(outline, "Third level").boundingBox())?.x;
    if (x1 == null || x2 == null || x3 == null)
      throw new Error("Outline entries lack visible bounds");
    expect(x2).toBeGreaterThan(x1);
    expect(x3).toBeGreaterThan(x2);

    const mode = page.getByTestId("document-mode-trigger");
    await mode.click();
    await page.getByTestId("document-mode-suggesting").click();
    await expect(mode).toContainText("Suggesting");
    await expect(page.getByTestId("document-save-status")).toHaveAttribute(
      "aria-label",
      "Saved",
    );

    const richHeading = richTextEditor(page)
      .locator("h2") // selector-check-ignore: actual heading position is the browser navigation behavior under test.
      .filter({ hasText: "Repeated" })
      .nth(1);
    const beforeRich = await richHeading.boundingBox();
    if (!beforeRich) throw new Error("Second rendered heading lacks bounds");
    await entry(outline, "Repeated").nth(1).click();
    await expect
      .poll(async () => (await richHeading.boundingBox())?.y ?? Infinity)
      .toBeLessThan(800);
    const afterRich = await richHeading.boundingBox();
    expect((afterRich?.y ?? Infinity) + 200).toBeLessThan(beforeRich.y);
    await expect(entry(outline, "Repeated").nth(1)).toHaveAttribute(
      "aria-current",
      "location",
    );
    expect(readProjectFile(projectDir, "guide.md")).toBe(markdown);
    await expect(mode).toContainText("Suggesting");
    await expect(page.getByTestId("document-save-status")).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    await expect(
      richTextEditor(page).locator(".critic-change-addition"), // selector-check-ignore: no rendered suggestion may be created by outline navigation.
    ).toHaveCount(0);
    if (process.env.ROUGHDRAFT_CAPTURE_SCREENSHOTS === "1") {
      const directory = path.resolve(
        import.meta.dirname,
        "../../../.context/ui-state-screenshots/document-outline",
      );
      fs.mkdirSync(directory, { recursive: true });
      await page.screenshot({
        path: path.join(directory, "desktop-rich-text.png"),
        animations: "disabled",
      });
    }
    await page
      .getByTestId("document-workspace")
      .evaluate((element) => element.scrollTo(0, 0));
    await expect(entry(outline, "Guide")).toHaveAttribute(
      "aria-current",
      "location",
    );

    await page.getByTestId("document-editor-view-toggle").click();
    await expect(page.getByTestId("markdown-code-editor")).toBeVisible();
    const sourceScroller = page
      .getByTestId("markdown-code-editor")
      .locator(".cm-scroller"); // selector-check-ignore: inspect the CodeMirror scroll root when verifying source navigation.
    const workspace = page.getByTestId("document-workspace");
    await workspace.evaluate((element) => element.scrollTo(0, 0));
    await sourceScroller.evaluate((element) => element.scrollTo(0, 0));
    await entry(outline, "Sixth level").click();
    await expect
      .poll(() => workspace.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(300);
    const sourceHeading = page
      .getByTestId("markdown-code-editor")
      .locator(".cm-line") // selector-check-ignore: CodeMirror's rendered heading line is the visible navigation target.
      .filter({ hasText: "###### Sixth level" });
    await expect(sourceHeading).toBeVisible();
    await expect
      .poll(async () => (await sourceHeading.boundingBox())?.y ?? Infinity)
      .toBeLessThan(850);
    await expect(entry(outline, "Sixth level")).toHaveAttribute(
      "aria-current",
      "location",
    );
    expect(readProjectFile(projectDir, "guide.md")).toBe(markdown);
    await sourceHeading.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("## Source addition");
    await page.keyboard.press("Enter");
    await expect(entry(outline, "Source addition")).toBeVisible();
    await expect(entry(outline, "Source addition")).toHaveAttribute(
      "data-level",
      "2",
    );
    logE2eEvent("document-outline.desktop-navigation", {
      entries: 7,
      richHeadingBeforeY: beforeRich.y,
      richHeadingAfterY: afterRich?.y,
      workspaceScrollTop: await workspace.evaluate(
        (element) => element.scrollTop,
      ),
      sourceScrollTop: await sourceScroller.evaluate(
        (element) => element.scrollTop,
      ),
      sourceHeadingY: (await sourceHeading.boundingBox())?.y,
    });

    await expect(sidebar).toBeVisible();
    if (process.env.ROUGHDRAFT_CAPTURE_SCREENSHOTS === "1") {
      const directory = path.resolve(
        import.meta.dirname,
        "../../../.context/ui-state-screenshots/document-outline",
      );
      fs.mkdirSync(directory, { recursive: true });
      await page.screenshot({
        path: path.join(directory, "desktop.png"),
        animations: "disabled",
      });
    }
  });

  test("rich-text heading rename, removal, and addition update the outline immediately", async ({
    page,
  }) => {
    const documentPath = writeProjectFile(
      projectDir,
      "editing.md",
      "# Editing guide\n\n## Mutable title\n\nBody.\n",
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await openMarkdownFile(page, documentPath);
    const outline = page
      .getByTestId("document-outline-sidebar")
      .getByTestId("document-outline-navigation");
    await expect(entry(outline, "Mutable title")).toBeVisible();
    const mode = page.getByTestId("document-mode-trigger");
    await mode.click();
    await page.getByTestId("document-mode-editing").click();
    await expect(mode).toContainText("Editing");

    await selectRichText(page, "Mutable title");
    await page.keyboard.type("Renamed title");
    await expect(entry(outline, "Mutable title")).toHaveCount(0);
    await expect(entry(outline, "Renamed title")).toBeVisible();

    await selectRichText(page, "Renamed title");
    await page.keyboard.press("Backspace");
    await expect(entry(outline, "Renamed title")).toHaveCount(0);
    await page.keyboard.type("Added title");
    await expect(entry(outline, "Added title")).toBeVisible();
    await expect(entry(outline, "Added title")).toHaveAttribute(
      "data-level",
      "2",
    );
    logE2eEvent("document-outline.rich-live-update", {
      entries: await outline.getByTestId("document-outline-entry").count(),
    });
  });

  test("narrow outline stays visible and supports keyboard navigation without overflow @smoke", async ({
    page,
  }) => {
    const markdown = [
      "# Narrow guide",
      "",
      filler.repeat(30),
      "## Later section",
      "",
      filler.repeat(4),
    ].join("\n");
    const documentPath = writeProjectFile(projectDir, "narrow.md", markdown);
    await page.setViewportSize({ width: 390, height: 700 });
    await openMarkdownFile(page, documentPath);
    const sidebar = page.getByTestId("document-outline-sidebar");
    await expect(sidebar).toBeVisible();
    const outline = sidebar.getByTestId("document-outline-navigation");
    await expect(outline).toHaveAttribute("aria-label", "Document outline");
    const later = entry(outline, "Later section");
    await expect(later).toBeVisible();
    await later.focus();
    await page.keyboard.press("Enter");
    const target = richTextEditor(page)
      .locator("h2") // selector-check-ignore: verify navigation visibly reveals the actual document heading.
      .filter({ hasText: "Later section" });
    await expect
      .poll(async () => (await target.boundingBox())?.y ?? Infinity)
      .toBeLessThan(700);
    expect(readProjectFile(projectDir, "narrow.md")).toBe(markdown);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    logE2eEvent("document-outline.narrow-persistent", {
      targetY: (await target.boundingBox())?.y,
      scrollWidth: await page.evaluate(
        () => document.documentElement.scrollWidth,
      ),
    });
    if (process.env.ROUGHDRAFT_CAPTURE_SCREENSHOTS === "1") {
      const directory = path.resolve(
        import.meta.dirname,
        "../../../.context/ui-state-screenshots/document-outline",
      );
      fs.mkdirSync(directory, { recursive: true });
      await page.screenshot({
        path: path.join(directory, "narrow-persistent.png"),
        animations: "disabled",
      });
    }
  });

  test("long outline wraps titles and scrolls independently of the document", async ({
    page,
  }) => {
    const longTitle =
      "A very long chapter title that must wrap inside the narrow outline without widening the page or covering the document";
    const markdown = [
      "# Long guide",
      "",
      `## ${longTitle}`,
      "",
      "Opening paragraph.",
      "",
      ...Array.from(
        { length: 65 },
        (_, index) =>
          `## Section ${index + 1}\n\nBody of section ${index + 1}.\n`,
      ),
    ].join("\n");
    const documentPath = writeProjectFile(projectDir, "long.md", markdown);
    await page.setViewportSize({ width: 768, height: 600 });
    await openMarkdownFile(page, documentPath);
    const sidebar = page.getByTestId("document-outline-sidebar");
    const outline = sidebar.getByTestId("document-outline-navigation");
    const workspace = page.getByTestId("document-workspace");
    await expect(sidebar).toBeVisible();
    await expect(entry(outline, "Section 65")).toHaveCount(1);
    const long = entry(outline, longTitle);
    const short = entry(outline, "Section 1");
    const longBox = await long.boundingBox();
    const shortBox = await short.boundingBox();
    if (!longBox || !shortBox)
      throw new Error("Long and short outline entries lack bounds");
    expect(longBox.height).toBeGreaterThan(shortBox.height);
    expect(
      await long.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    const documentScrollBefore = await workspace.evaluate(
      (element) => element.scrollTop,
    );
    await outline.hover();
    await page.mouse.wheel(0, 700);
    await expect
      .poll(() => outline.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(200);
    expect(await workspace.evaluate((element) => element.scrollTop)).toBe(
      documentScrollBefore,
    );

    await entry(outline, "Section 55").click();
    await expect(entry(outline, "Section 55")).toHaveAttribute(
      "aria-current",
      "location",
    );
    const outlineScrollAfterSelection = await outline.evaluate(
      (element) => element.scrollTop,
    );
    expect(outlineScrollAfterSelection).toBeGreaterThan(0);
    await expect
      .poll(() => workspace.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(documentScrollBefore + 300);
    expect(readProjectFile(projectDir, "long.md")).toBe(markdown);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(768);
    logE2eEvent("document-outline.independent-scroll", {
      longEntryHeight: longBox.height,
      shortEntryHeight: shortBox.height,
      outlineScrollAfterSelection,
      documentScrollBefore,
      documentScrollAfter: await workspace.evaluate(
        (element) => element.scrollTop,
      ),
    });
  });

  test("comment overlay and selected heading remain usable when resizing narrow to wide", async ({
    page,
  }) => {
    const markdown = [
      "# Commented guide",
      "",
      filler.repeat(24),
      "## Section with review",
      "",
      'This {==passage==}{>>Please clarify.<<}{id="c1" by="user" at="2026-04-23T18:00:00.000Z"} has a comment.',
      "",
    ].join("\n");
    const documentPath = writeProjectFile(projectDir, "commented.md", markdown);
    await page.setViewportSize({ width: 390, height: 900 });
    await openMarkdownFile(page, documentPath);
    const sidebar = page.getByTestId("document-outline-sidebar");
    const sheet = page.getByTestId("document-content-card");
    const rail = page.getByTestId("document-review-rail");
    const dock = page.getByTestId("document-comment-dock");
    await expect(sidebar).toBeVisible();
    const outline = sidebar.getByTestId("document-outline-navigation");
    const section = entry(outline, "Section with review");
    await section.click();
    await expect(section).toHaveAttribute("aria-current", "location");
    const passage = page.getByTestId("comment-decoration").filter({
      hasText: "passage",
    });
    await passage.click();
    await expect(dock.getByTestId("document-comment-fallback")).toBeVisible();
    const narrowOutline = await sidebar.boundingBox();
    const narrowSheet = await sheet.boundingBox();
    const narrowDock = await dock
      .getByTestId("document-comment-fallback")
      .boundingBox();
    if (!narrowOutline || !narrowSheet || !narrowDock)
      throw new Error("Narrow outline, sheet, or comment overlay lacks bounds");
    expect(narrowOutline.x + narrowOutline.width).toBeLessThanOrEqual(
      narrowSheet.x,
    );
    expect(narrowDock.x).toBeGreaterThanOrEqual(narrowSheet.x);
    expect(narrowDock.x + narrowDock.width).toBeLessThanOrEqual(390);
    if (process.env.ROUGHDRAFT_CAPTURE_SCREENSHOTS === "1") {
      const directory = path.resolve(
        import.meta.dirname,
        "../../../.context/ui-state-screenshots/document-outline",
      );
      fs.mkdirSync(directory, { recursive: true });
      await page.screenshot({
        path: path.join(directory, "narrow-open-comment.png"),
        animations: "disabled",
      });
    }
    await expect(section).toHaveAttribute("aria-current", "location");
    const target = richTextEditor(page)
      .locator("h2") // selector-check-ignore: visible target position verifies navigation beside a comment rail.
      .filter({ hasText: "Section with review" });
    await expect
      .poll(async () => (await target.boundingBox())?.y ?? Infinity)
      .toBeLessThan(850);
    await expect(dock.getByTestId("document-comment-fallback")).toBeVisible();
    expect(readProjectFile(projectDir, "commented.md")).toBe(markdown);
    await page.setViewportSize({ width: 2012, height: 900 });
    await expect(sidebar).toBeVisible();
    await expect(section).toHaveAttribute("aria-current", "location");
    await expect(page.getByTestId("comment-thread-c1")).toBeVisible();
    await expect(rail).toBeVisible();
    const wideOutline = await sidebar.boundingBox();
    const wideSheet = await sheet.boundingBox();
    const wideRail = await rail.boundingBox();
    if (!wideOutline || !wideSheet || !wideRail)
      throw new Error("Wide outline, sheet, or comment rail lacks bounds");
    expect(wideOutline.x + wideOutline.width).toBeLessThanOrEqual(wideSheet.x);
    expect(wideSheet.x + wideSheet.width).toBeLessThanOrEqual(wideRail.x);
    expect(wideRail.x + wideRail.width).toBeLessThanOrEqual(2012);
    expect(readProjectFile(projectDir, "commented.md")).toBe(markdown);
    logE2eEvent("document-outline.comment-layout", {
      narrowOutline,
      narrowSheet,
      narrowRail: narrowDock,
      wideOutline,
      wideSheet,
      wideRail,
      targetY: (await target.boundingBox())?.y,
    });
  });
});
