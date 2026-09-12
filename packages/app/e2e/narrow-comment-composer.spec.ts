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

async function paragraphBounds(passage: Locator) {
  return passage.evaluate((element) => {
    const paragraph = element.closest("p");
    if (!paragraph) throw new Error("The selected passage has no paragraph.");
    const rect = paragraph.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
}

async function clickVisibleCommentAction(
  page: import("@playwright/test").Page,
) {
  await page.getByTestId("selection-menu").evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
  const action = page.getByTestId("selection-menu-action-comment");
  await expect(action).toBeInViewport({ ratio: 1 });
  const box = await action.boundingBox();
  if (!box) throw new Error("The Comment action is not visible.");
  // A real pointer click avoids locator.click scrolling the absolute selection
  // menu's ancestors before the user action under test has even started.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function textContrast(control: Locator) {
  return control.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Cannot measure rendered text colors.");
    context.fillStyle = "white";
    context.fillRect(0, 0, 1, 1);
    const ancestors: Element[] = [];
    for (let node: Element | null = element; node; node = node.parentElement)
      ancestors.push(node);
    for (const node of ancestors.reverse()) {
      context.fillStyle = getComputedStyle(node).backgroundColor;
      context.fillRect(0, 0, 1, 1);
    }
    const background = Array.from(context.getImageData(0, 0, 1, 1).data).slice(
      0,
      3,
    );
    const color = getComputedStyle(element).color;
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const foreground = Array.from(context.getImageData(0, 0, 1, 1).data).slice(
      0,
      3,
    );
    const luminance = (rgb: number[]) =>
      rgb
        .map((channel) => {
          const value = channel / 255;
          return value <= 0.04045
            ? value / 12.92
            : ((value + 0.055) / 1.055) ** 2.4;
        })
        .reduce(
          (sum, channel, index) =>
            sum + channel * [0.2126, 0.7152, 0.0722][index],
          0,
        );
    const values = [luminance(background), luminance(foreground)].sort(
      (a, b) => a - b,
    );
    return {
      color,
      background,
      ratio: (values[1] + 0.05) / (values[0] + 0.05),
    };
  });
}

test.describe("narrow comment composer", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("narrow-comment-composer");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  for (const { embedded, width, alignment } of [
    { embedded: false, width: 900, alignment: "center" },
    { embedded: false, width: 390, alignment: "center" },
    { embedded: true, width: 900, alignment: "center" },
    { embedded: false, width: 900, alignment: "end" },
  ] as const) {
    test(`keeps deep selected text visible while focusing and saving a bottom composer at ${width}px${embedded ? " in embed mode" : ""}${alignment === "end" ? " with an anchor near the bottom" : ""} @smoke`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 800 });
      const targetText = "Review this deep passage without losing your place.";
      const filePath = writeProjectFile(
        projectDir,
        "long-review.md",
        [
          "# Long review",
          ...Array.from(
            { length: 35 },
            (_, index) =>
              `\nParagraph ${index + 1} gives this review enough content to scroll.`,
          ),
          `\n${targetText}`,
          ...Array.from(
            { length: 35 },
            (_, index) =>
              `\nFollowing paragraph ${index + 1} continues the document.`,
          ),
          "",
        ].join("\n"),
      );

      if (embedded) {
        await page.goto(
          `/?${new URLSearchParams({ path: filePath, embed: "1" })}`,
        );
      } else {
        await openMarkdownFile(page, filePath);
      }
      await richTextEditor(page).focus();
      const passage = richTextEditor(page).getByText(targetText, {
        exact: true,
      });
      await passage.evaluate(
        (element, block) => element.scrollIntoView({ block }),
        alignment,
      );
      await selectRichText(page, targetText);
      await expect(
        page.getByTestId("selection-menu-action-comment"),
      ).toBeInViewport({ ratio: 1 });
      const before = await paragraphBounds(passage);
      await expect(passage).toBeInViewport();

      await clickVisibleCommentAction(page);
      const composer = page
        .getByTestId(/comment-(banner|rail)-c1-editor$/)
        .filter({ visible: true });
      await expect(composer).toBeFocused();
      const after = await paragraphBounds(passage);
      const composerBox = await composer.boundingBox();
      const layout = {
        embedded,
        width,
        alignment,
        before,
        after,
        composer: composerBox,
      };
      logE2eEvent("narrow-comment-composer.focus-layout", layout);
      await testInfo.attach("focused-composer-layout", {
        body: JSON.stringify(layout, null, 2),
        contentType: "application/json",
      });

      await expect(passage).toBeInViewport();
      if (!composerBox) throw new Error("The focused composer is not visible.");
      expect(composerBox.y).toBeGreaterThan(after.y + after.height);
      expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(800);
      if (!embedded) {
        const dockBox = await page
          .getByTestId("document-comment-dock")
          .boundingBox();
        if (!dockBox)
          throw new Error("The narrow comment dock is not visible.");
        expect(after.y + after.height).toBeLessThan(dockBox.y);
        if (alignment === "center") {
          expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(2);
        }
        await expect(page.getByTestId("document-review-rail")).toBeHidden();
      }

      await composer.fill("Keep the document context visible.");
      const screenshotDir = path.resolve(
        import.meta.dirname,
        "../../../.context/ui-state-screenshots/comment-dock",
      );
      fs.mkdirSync(screenshotDir, { recursive: true });
      await page.mouse.move(width - 2, 500);
      await expect(page.getByTestId("selection-menu")).toBeHidden();
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await expect
          .poll(() =>
            page.evaluate(() =>
              document.documentElement.classList.contains("dark"),
            ),
          )
          .toBe(colorScheme === "dark");
        await page.evaluate(async () => {
          await Promise.all(
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.effect?.getComputedTiming().iterations !==
                  Number.POSITIVE_INFINITY,
              )
              .map((animation) => animation.finished.catch(() => undefined)),
          );
        });
        if (colorScheme === "dark") {
          for (const control of [
            composer,
            page
              .getByTestId(/comment-(banner|rail)-c1-action-save$/)
              .filter({ visible: true }),
          ]) {
            await expect
              .poll(async () => (await textContrast(control)).ratio)
              .toBeGreaterThanOrEqual(4.5);
            logE2eEvent("narrow-comment-composer.dark-contrast", {
              embedded,
              width,
              control: await control.getAttribute("data-testid"),
              ...(await textContrast(control)),
            });
          }
        }
        await page.screenshot({
          path: path.join(
            screenshotDir,
            `${embedded ? "embed" : "regular"}-${width}-${alignment}-${colorScheme}.png`,
          ),
        });
      }
      await page
        .getByTestId(/comment-(banner|rail)-c1-action-save$/)
        .filter({ visible: true })
        .click();
      await expect
        .poll(() => readProjectFile(projectDir, "long-review.md"))
        .toContain("{>>Keep the document context visible.<<}");
      await expect(passage).toBeInViewport();

      // A dock must leave the header handoff controls clickable.
      await page.getByTestId("review-handoff-comment-trigger").click();
      await expect(
        page.getByTestId("review-handoff-overall-comment"),
      ).toBeVisible();
    });
  }

  test("keeps the desktop composer beside the document in its review rail", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const targetText = "Keep desktop comments beside their passage.";
    const filePath = writeProjectFile(
      projectDir,
      "desktop-review.md",
      [
        "# Desktop review",
        ...Array.from(
          { length: 30 },
          (_, index) => `\nParagraph ${index + 1}.`,
        ),
        `\n${targetText}`,
        ...Array.from(
          { length: 10 },
          (_, index) => `\nFollowing paragraph ${index + 1}.`,
        ),
        "",
      ].join("\n"),
    );
    await openMarkdownFile(page, filePath);
    await richTextEditor(page).focus();
    const passage = richTextEditor(page).getByText(targetText, { exact: true });
    await passage.evaluate((element) =>
      element.scrollIntoView({ block: "center" }),
    );
    await selectRichText(page, targetText);
    await clickVisibleCommentAction(page);
    const composer = page.getByTestId("comment-rail-c1-editor");
    await expect(composer).toBeFocused();
    await expect(passage).toBeInViewport();
    await expect(page.getByTestId("document-comment-fallback")).toBeHidden();
    const cardBox = await page
      .getByTestId("document-content-card")
      .boundingBox();
    const composerBox = await composer.boundingBox();
    if (!cardBox || !composerBox) {
      throw new Error("The desktop document and composer must be visible.");
    }
    expect(composerBox.x).toBeGreaterThan(cardBox.x + cardBox.width);
    await composer.fill("Desktop rail remains usable.");
    await page.getByTestId("comment-rail-c1-action-save").click();
    await expect
      .poll(() => readProjectFile(projectDir, "desktop-review.md"))
      .toContain("{>>Desktop rail remains usable.<<}");
    logE2eEvent("narrow-comment-composer.desktop-rail", {
      cardBox,
      composerBox,
    });
  });

  test("keeps the root passage clear when a reply screenshot grows the dock", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    const targetText = "The screenshot reply belongs to this passage.";
    const filePath = writeProjectFile(
      projectDir,
      "reply-review.md",
      [
        "# Reply context",
        ...Array.from(
          { length: 35 },
          (_, index) => `\nEarlier paragraph ${index + 1}.`,
        ),
        `\n{==${targetText}==}{>>Please check the layout.<<}{#c1}`,
        ...Array.from(
          { length: 35 },
          (_, index) => `\nLater paragraph ${index + 1}.`,
        ),
        "\n---\ncomments:\n  c1:\n    by: user\n",
      ].join("\n"),
    );
    await openMarkdownFile(page, filePath);
    const passage = page
      .getByTestId("comment-decoration")
      .filter({ hasText: targetText });
    await passage.evaluate((element) =>
      element.scrollIntoView({ block: "center" }),
    );
    await passage.click();
    const screenshot = await page.screenshot();
    await page.getByTestId("comment-banner-c1-action-reply").click();
    const reply = page.getByTestId("comment-banner-c2-editor");
    await reply.fill("The screenshot shows the remaining problem.");
    await page
      .getByTestId("comment-banner-c2-editor-file-input")
      .setInputFiles({
        name: "reply-context.png",
        mimeType: "image/png",
        buffer: screenshot,
      });
    await expect(reply).toHaveValue(/reply-context\.png/);
    const dock = page.getByTestId("document-comment-dock");
    await expect
      .poll(() =>
        dock
          .getByTestId("comment-image")
          .evaluate((node: HTMLImageElement) => node.naturalWidth),
      )
      .toBeGreaterThan(0);
    logE2eEvent("narrow-comment-composer.reply-growth", {
      anchor: await paragraphBounds(passage),
      dock: await dock.boundingBox(),
    });
    await expect
      .poll(async () => {
        const anchor = await paragraphBounds(passage);
        const dockBox = await dock.boundingBox();
        return dockBox
          ? anchor.y + anchor.height - dockBox.y
          : Number.POSITIVE_INFINITY;
      })
      .toBeLessThan(0);
    await page.getByTestId("comment-banner-c2-action-save").click();
    await expect
      .poll(() => readProjectFile(projectDir, "reply-review.md"))
      .toContain("reply-context.png");
  });
});
