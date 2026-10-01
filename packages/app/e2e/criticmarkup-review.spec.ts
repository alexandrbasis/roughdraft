import { expect, type Page, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  selectRichText,
  writeProjectFile,
} from "./helpers";

test.describe("CriticMarkup review flows", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("criticmarkup");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("renders a comment thread and saves a reply @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "comment.md",
      [
        "# Comment Review",
        "",
        'This paragraph has {==target text==}{>>Needs detail<<}{id="c1" by="user" at="2026-04-23T18:00:00.000Z"}.',
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "Needs detail",
    );

    await page
      .getByTestId("comment-rail-c1-action-reply")
      .evaluate((element) => {
        (element as HTMLButtonElement).click();
      });
    await page
      .getByTestId("comment-rail-c2-editor")
      .fill("Added context looks good.");
    await page
      .getByTestId("comment-rail-c2-action-save")
      .evaluate((element) => {
        (element as HTMLButtonElement).click();
      });

    await expect
      .poll(() => readProjectFile(projectDir, "comment.md"))
      .toContain("Added context looks good.");
    expect(readProjectFile(projectDir, "comment.md")).toContain('re="c1"');

    logE2eEvent("criticmarkup.reply-saved", {
      file: "comment.md",
    });
  });

  test("creates a new root comment and saves it to disk @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "new-comment.md",
      [
        "# New Comment",
        "",
        "This paragraph has target text to review.",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await selectRichText(page, "target text");
    await page.getByTestId("selection-menu-action-comment").click();
    await page
      .getByTestId("comment-rail-c1-editor")
      .fill("Clarify this phrase.");
    await page.getByTestId("comment-rail-c1-action-save").click();

    await expect
      .poll(() => readProjectFile(projectDir, "new-comment.md"))
      .toMatch(
        /\{==target text==\}\{>>Clarify this phrase\.<<\}\{id="c1" by="user" at="[^"]+"\}/,
      );

    logE2eEvent("criticmarkup.root-comment-saved", {
      file: "new-comment.md",
    });
  });

  test("animates the document layout when the review rail appears and disappears @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "layout-animation.md",
      [
        "# Layout Animation",
        "",
        "This paragraph has target text to review.",
        ...Array.from(
          { length: 24 },
          (_, index) => `\nParagraph ${index + 1} extends the document.`,
        ),
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await selectRichText(page, "target text");
    await page.getByTestId("selection-menu-action-comment").waitFor();

    const addSamples = await sampleReviewLayoutAnimation(
      page,
      "selection-menu-action-comment",
    );

    expect(
      hasAnimatedReviewLayout(addSamples),
      JSON.stringify(addSamples),
    ).toBe(true);
    expect(
      addSamples.every((sample) => Math.abs(sample.toolsTranslateX) < 1),
    ).toBe(true);
    await page
      .getByTestId("comment-rail-c1-editor")
      .fill("Clarify this phrase.");
    await page.getByTestId("comment-rail-c1-action-save").click();

    const tools = page.getByTestId("document-floating-tools");
    await expect(tools).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId("document-editor-view-toggle")).toBeVisible();
    const editorTextBox = await page
      .getByTestId("rich-text-editor")
      .locator(".ProseMirror")
      .boundingBox();
    if (!editorTextBox)
      throw new Error("The editor text has no rendered bounds.");
    expect(
      await page
        .getByTestId("document-floating-rail")
        .evaluate((element) => getComputedStyle(element).position),
    ).toBe("fixed");
    const toolsBeforeScroll = await tools.boundingBox();
    const scrollTop = await page
      .getByTestId("document-workspace")
      .evaluate((element) => {
        element.scrollTop = 250;
        return element.scrollTop;
      });
    expect(scrollTop).toBeGreaterThan(0);
    const toolsAfterScroll = await tools.boundingBox();
    if (!toolsBeforeScroll || !toolsAfterScroll) {
      throw new Error("The document tools have no rendered bounds.");
    }
    expect(toolsAfterScroll.x + toolsAfterScroll.width).toBeLessThanOrEqual(
      editorTextBox.x,
    );
    expect(
      Math.abs(toolsAfterScroll.x - toolsBeforeScroll.x),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(toolsAfterScroll.y - toolsBeforeScroll.y),
    ).toBeLessThanOrEqual(1);
    await expect(tools).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId("document-editor-view-toggle")).toBeVisible();

    await page.getByTestId("comment-rail-c1-action-delete-thread").waitFor();
    const removeSamples = await sampleReviewLayoutAnimation(
      page,
      "comment-rail-c1-action-delete-thread",
    );

    expect(
      hasAnimatedReviewLayout(removeSamples),
      JSON.stringify(removeSamples),
    ).toBe(true);
    expect(
      removeSamples.every((sample) => Math.abs(sample.toolsTranslateX) < 1),
    ).toBe(true);

    logE2eEvent("criticmarkup.layout-animation", {
      file: "layout-animation.md",
      addSamples,
      removeSamples,
      toolsBeforeScroll,
      toolsAfterScroll,
    });
  });

  test("shows tooltips for selection menu formatting actions", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "selection-tooltips.md",
      [
        "# Selection Tooltips",
        "",
        "This paragraph has target text to review.",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await selectRichText(page, "target text");

    await page.getByTestId("selection-menu-action-bold").hover();
    await expect(page.getByTestId("selection-menu-action-tooltip")).toHaveText(
      "Bold",
    );

    await expect(
      page.getByTestId("selection-menu-action-suggest-insertion"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("selection-menu-action-suggest-deletion"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("selection-menu-action-suggest-replacement"),
    ).toHaveCount(0);

    await page.getByTestId("selection-menu-action-comment").hover();
    await expect(page.getByTestId("selection-menu-action-tooltip")).toHaveCount(
      0,
    );
  });

  test("accepts and rejects suggested changes on disk @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "suggestions.md",
      [
        "# Suggestion Review",
        "",
        'Keep {++clear wording++}{id="s1" by="user" at="2026-04-23T18:00:00.000Z"} here.',
        "",
        'Remove {--drafty --}{id="s2" by="user" at="2026-04-23T18:01:00.000Z"}there.',
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await expect(page.locator('[data-critic-change-id="s1"]')).toBeVisible();

    await page.getByTestId("comment-rail-s1-action-accept").click();
    await expect
      .poll(() => readProjectFile(projectDir, "suggestions.md"))
      .toContain("Keep clear wording here.");

    await page.getByTestId("comment-rail-s2-action-reject").click();
    await expect
      .poll(() => readProjectFile(projectDir, "suggestions.md"))
      .toContain("Remove drafty there.");
    expect(readProjectFile(projectDir, "suggestions.md")).not.toContain("{++");
    expect(readProjectFile(projectDir, "suggestions.md")).not.toContain("{--");

    logE2eEvent("criticmarkup.suggestions-applied", {
      file: "suggestions.md",
    });
  });
});

type ReviewLayoutAnimationSample = {
  shellAnimating: boolean;
  shellTranslateX: number;
  toolsTranslateX: number;
};

async function sampleReviewLayoutAnimation(page: Page, actionTestId: string) {
  // Arm in the browser before clicking, but start the window on the actual
  // click. Playwright's actionability checks can outlast the animation itself.
  const sampler = await page.evaluateHandle((testId) => {
    const action = document.querySelector(`[data-testid="${testId}"]`);
    if (!action) throw new Error(`Animation trigger is missing: ${testId}`);
    const readTranslateX = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) return 0;
      const transform = getComputedStyle(element).transform;
      if (transform === "none") return 0;
      return new DOMMatrixReadOnly(transform).m41;
    };
    const samples: ReviewLayoutAnimationSample[] = [];
    const result = new Promise<ReviewLayoutAnimationSample[]>((resolve) => {
      action.addEventListener(
        "click",
        () => {
          const start = performance.now();
          const sample = () => {
            const shell = document.querySelector(
              '[data-testid="document-page-shell"]',
            );
            const tools = document.querySelector(
              '[data-testid="document-floating-tools"]',
            );
            samples.push({
              shellAnimating:
                shell instanceof HTMLElement &&
                shell.classList.contains("review-layout-grid--animating"),
              shellTranslateX: readTranslateX(shell),
              toolsTranslateX: readTranslateX(tools),
            });
            if (performance.now() - start < 500) requestAnimationFrame(sample);
            else resolve(samples);
          };
          sample();
        },
        { capture: true, once: true },
      );
    });
    return { result };
  }, actionTestId);

  try {
    await page.getByTestId(actionTestId).click();
    return await sampler.evaluate(async ({ result }) => await result);
  } finally {
    await sampler.dispose();
  }
}

function hasAnimatedReviewLayout(samples: ReviewLayoutAnimationSample[]) {
  return samples.some(
    (sample) => sample.shellAnimating && Math.abs(sample.shellTranslateX) > 1,
  );
}
