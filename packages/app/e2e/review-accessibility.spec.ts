import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

function reviewDocument(extraParagraphs = "") {
  return [
    "# Keyboard review",
    "",
    'This paragraph has {==target text==}{>>Needs detail<<}{id="c1" by="user" at="2026-04-23T18:00:00.000Z"}.',
    extraParagraphs,
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

test.describe("Review accessibility", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("review-accessibility");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("expands a collapsed comment thread from the keyboard", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const filePath = writeProjectFile(
      projectDir,
      "keyboard-thread.md",
      reviewDocument(),
    );

    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("comment-thread-c1")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("before-keyboard-thread-1280-light.png"),
      fullPage: true,
    });

    const thread = page.getByTestId("comment-thread-c1");
    logE2eEvent("review-accessibility.before-keyboard-expand", {
      role: await thread.getAttribute("role"),
      tabIndex: await thread.getAttribute("tabindex"),
      ariaExpanded: await thread.getAttribute("aria-expanded"),
    });
    await thread.focus();
    await expect(thread).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(
      page.getByTestId("comment-rail-c1-action-reply"),
    ).toBeVisible();
    await expect(thread).toBeFocused();

    logE2eEvent("review-accessibility.keyboard-expand", {
      viewport: 1280,
    });
  });

  test("returns focus to Reply after cancelling a keyboard-created reply", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const filePath = writeProjectFile(
      projectDir,
      "reply-focus.md",
      reviewDocument(),
    );

    await openMarkdownFile(page, filePath);
    const thread = page.getByTestId("comment-thread-c1");
    await thread.click();

    const reply = page.getByTestId("comment-rail-c1-action-reply");
    await reply.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("comment-rail-c2-editor")).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("comment-rail-c2-editor")).toHaveCount(0);
    await expect(reply).toBeFocused();
    expect(readProjectFile(projectDir, "reply-focus.md")).not.toContain(
      'id="c2"',
    );
  });

  test("resolves a suggestion from the keyboard and keeps focus in the document", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const filePath = writeProjectFile(
      projectDir,
      "resolve-suggestion.md",
      [
        "# Resolve review",
        "",
        'Keep {++clear wording++}{id="s1" by="user" at="2026-04-23T18:00:00.000Z"} here.',
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    const suggestion = page.getByTestId("suggestion-thread-s1");
    await suggestion.click();

    const accept = page.getByTestId("comment-rail-s1-action-accept");
    await accept.focus();
    await page.keyboard.press("Enter");

    await expect(suggestion).toHaveCount(0);
    await expect(page.locator(".ProseMirror")).toBeFocused();
    await expect
      .poll(() => readProjectFile(projectDir, "resolve-suggestion.md"))
      .toContain("Keep clear wording here.");
  });

  test("offers a keyboard-reachable jump to comments in a long embedded document", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 380, height: 720 });
    const longBody = Array.from(
      { length: 36 },
      (_, index) =>
        `Long paragraph ${index + 1} keeps the review target below the fold.`,
    ).join("\n\n");
    const filePath = writeProjectFile(
      projectDir,
      "embedded-long.md",
      reviewDocument(longBody),
    );

    await page.goto(`/?${new URLSearchParams({ path: filePath, embed: "1" })}`);

    const jumpLink = page.getByTestId("document-review-comments-link");
    await expect(jumpLink).toBeVisible();
    await jumpLink.focus();
    await expect(jumpLink).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("document-review-rail")).toBeInViewport();
  });

  test("captures changed review states across narrow and desktop layouts", async ({
    page,
  }, testInfo) => {
    const filePath = writeProjectFile(
      projectDir,
      "review-state-captures.md",
      reviewDocument(
        Array.from(
          { length: 18 },
          (_, index) => `Review context paragraph ${index + 1}.`,
        ).join("\n\n"),
      ),
    );

    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });

      for (const width of [380, 720, 1280]) {
        await page.setViewportSize({ width, height: 720 });
        const embedded = width < 900;
        await page.goto(
          `/?${new URLSearchParams({
            path: filePath,
            ...(embedded ? { embed: "1" } : {}),
          })}`,
        );
        await expect(page.getByTestId("page-card-rich-text")).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath(`review-${width}-${colorScheme}.png`),
          fullPage: true,
        });
      }
    }
  });
});
