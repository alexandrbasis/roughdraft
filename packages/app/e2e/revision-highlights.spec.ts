import fs from "node:fs";
import path from "node:path";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

interface Revision {
  id: string;
  number: number;
  content: string;
  version: string;
  source: "baseline" | "external" | "review";
  createdAt: string;
}

async function revisions(request: APIRequestContext, documentPath: string) {
  const response = await request.get("/api/reviews/revisions", {
    params: { documentPath },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { revisions: Revision[] }).revisions;
}

async function register(request: APIRequestContext, documentPath: string) {
  const response = await request.post("/api/reviews", {
    data: { documentPath },
  });
  expect(response.status()).toBe(201);
}

async function changeOnDisk(
  request: APIRequestContext,
  directory: string,
  content: string,
) {
  const documentPath = writeProjectFile(directory, "review.md", content);
  await expect
    .poll(async () => (await revisions(request, documentPath)).at(-1)?.content)
    .toBe(content);
}

async function chooseRevision(page: Page, number: number | "all") {
  await page.getByTestId("revision-filter").click();
  await page
    .getByTestId(
      number === "all" ? "revision-filter-all" : `revision-filter-${number}`,
    )
    .click();
}

test.describe("document revision highlights", () => {
  let directory: string;

  test.beforeEach(() => {
    directory = createMarkdownProject("revisions");
  });

  test.afterEach(() => {
    removeMarkdownProject(directory);
  });

  test("keeps narrow document controls clear of the fixed Approve button", async ({
    page,
    request,
  }) => {
    const documentPath = writeProjectFile(
      directory,
      "review.md",
      "# Narrow review\n\nOriginal wording.\n",
    );
    await register(request, documentPath);
    await changeOnDisk(
      request,
      directory,
      "# Narrow review\n\nUpdated wording.\n",
    );
    await page.setViewportSize({ width: 390, height: 900 });
    await openMarkdownFile(page, documentPath);
    await expect(page.getByTestId("revision-highlight")).toBeVisible();
    await expect(page.getByTestId("review-handoff-split-button")).toBeVisible();
    await expect(page.getByTestId("document-mode-trigger")).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));

    const fixed = await page
      .getByTestId("review-handoff-split-button")
      .boundingBox();
    if (!fixed) throw new Error("Approve button has no visible box");
    for (const id of [
      "document-mode-trigger",
      "revision-filter",
      "revision-prev",
      "revision-next",
      "revision-details",
      "revision-toggle",
    ]) {
      const box = await page.getByTestId(id).boundingBox();
      if (!box) throw new Error(`${id} has no visible box`);
      const overlapWidth = Math.max(
        0,
        Math.min(box.x + box.width, fixed.x + fixed.width) -
          Math.max(box.x, fixed.x),
      );
      const overlapHeight = Math.max(
        0,
        Math.min(box.y + box.height, fixed.y + fixed.height) -
          Math.max(box.y, fixed.y),
      );
      expect(
        overlapWidth * overlapHeight,
        `${id} overlaps fixed Approve: ${JSON.stringify({ box, fixed, overlapWidth, overlapHeight })}`,
      ).toBe(0);
    }
  });

  test("shows every saved revision, filters and navigates changes, and keeps viewing read only @smoke", async ({
    page,
    request,
  }) => {
    const baseline = "# Review\n\nThe launch text starts here.\n";
    const first = "# Review\n\nThe launch text starts here. First addition.\n";
    const second =
      "# Review\n\nThe launch text starts here. First addition. Second addition.\n";
    const documentPath = writeProjectFile(directory, "review.md", baseline);
    await register(request, documentPath);
    expect(
      (await revisions(request, documentPath)).map((item) => item.number),
    ).toEqual([0]);
    await changeOnDisk(request, directory, first);
    await changeOnDisk(request, directory, second);
    const saved = await revisions(request, documentPath);
    expect(
      saved.map(({ number, content, source }) => ({ number, content, source })),
    ).toEqual([
      { number: 0, content: baseline, source: "baseline" },
      { number: 1, content: first, source: "external" },
      { number: 2, content: second, source: "external" },
    ]);
    expect(
      saved.every((item) => item.id && item.version && item.createdAt),
    ).toBe(true);

    await openMarkdownFile(page, documentPath);
    await expect(page.getByTestId("rich-text-editor")).toContainText(
      "Second addition.",
    );
    await expect(page.getByTestId("revision-toolbar")).toBeVisible();
    await expect(page.getByTestId("revision-count")).toContainText("2");
    await expect(
      page
        .getByTestId("revision-highlight")
        .filter({ hasText: "First addition." }),
    ).toBeVisible();
    await expect(
      page
        .getByTestId("revision-highlight")
        .filter({ hasText: "Second addition." }),
    ).toBeVisible();

    await chooseRevision(page, 1);
    await expect(page.getByTestId("revision-highlight")).toHaveCount(1);
    await expect(page.getByTestId("revision-highlight")).toHaveAttribute(
      "data-revision-number",
      "1",
    );
    await chooseRevision(page, 2);
    await expect(page.getByTestId("revision-highlight")).toHaveAttribute(
      "data-revision-number",
      "2",
    );
    await chooseRevision(page, "all");
    await expect(page.getByTestId("revision-highlight")).toHaveCount(2);

    await page.getByTestId("revision-next").click();
    await expect(page.getByTestId("revision-count")).toContainText("1 of 2");
    await expect(page.getByTestId("revision-details")).toBeEnabled();
    await page.getByTestId("revision-prev").click();
    await expect(page.getByTestId("revision-count")).toContainText("2 of 2");
    await page.getByTestId("revision-toggle").click();
    await expect(page.getByTestId("revision-highlight")).toHaveCount(0);
    await page.getByTestId("revision-toggle").click();
    await expect(page.getByTestId("revision-highlight")).toHaveCount(2);

    await page.reload();
    await expect(page.getByTestId("revision-highlight")).toHaveCount(2);
    expect(readProjectFile(directory, "review.md")).toBe(second);
    expect(
      (await revisions(request, documentPath)).map((item) => item.content),
    ).toEqual([baseline, first, second]);
    logE2eEvent("revision-highlights.read-only-roundtrip", { revisions: 3 });
  });

  test("picks up a new external revision while the clean document stays open", async ({
    page,
    request,
  }) => {
    const baseline = "# Live review\n\nThe initial wording.\n";
    const changed = "# Live review\n\nThe updated wording.\n";
    const documentPath = writeProjectFile(directory, "review.md", baseline);
    await register(request, documentPath);
    await openMarkdownFile(page, documentPath);
    await expect(page.getByTestId("rich-text-editor")).toContainText(
      "initial wording",
    );
    await expect(page.getByTestId("revision-toolbar")).toContainText(
      "Changes will appear after the next saved revision.",
    );

    await changeOnDisk(request, directory, changed);
    await expect(page.getByTestId("rich-text-editor")).toContainText(
      "updated wording",
    );
    await expect(
      page.getByTestId("revision-highlight").filter({ hasText: "updated" }),
    ).toHaveAttribute("data-revision-number", "1");
    expect(readProjectFile(directory, "review.md")).toBe(changed);
    logE2eEvent("revision-highlights.live-external-update", { observed: true });
  });

  test("attributes repeated rewrites to the latest revision", async ({
    page,
    request,
  }) => {
    const baseline = "# Review\n\nThe chosen label is alpha.\n";
    const first = "# Review\n\nThe chosen label is beta.\n";
    const latest = "# Review\n\nThe chosen label is gamma.\n";
    const documentPath = writeProjectFile(directory, "review.md", baseline);
    await register(request, documentPath);
    await changeOnDisk(request, directory, first);
    await changeOnDisk(request, directory, latest);

    await openMarkdownFile(page, documentPath);
    await expect(page.getByTestId("rich-text-editor")).toContainText("gamma");
    const gamma = page
      .getByTestId("revision-highlight")
      .filter({ hasText: "gamma" });
    await expect(gamma).toHaveAttribute("data-revision-number", "2");
    await chooseRevision(page, 1);
    await expect(
      page.getByTestId("revision-highlight").filter({ hasText: "gamma" }),
    ).toHaveCount(0);
    await chooseRevision(page, 2);
    await expect(gamma).toBeVisible();
    expect(readProjectFile(directory, "review.md")).toBe(latest);
  });

  test("renders deleted words and paragraphs in revision colors without restoring them on save @smoke", async ({
    page,
    request,
  }) => {
    const removedParagraph =
      "This obsolete paragraph explains the old behavior in enough detail to wrap across several lines on a narrow screen.";
    const baseline = `# Revision display\n\nStart fragile wording end.\n\n${removedParagraph}\n\nKeep this paragraph.\n`;
    const first = baseline.replace("fragile wording ", "");
    const second = first.replace(`${removedParagraph}\n\n`, "");
    const latest = second.replace(
      "Keep this paragraph.",
      "Keep this paragraph. New explanation.",
    );
    const documentPath = writeProjectFile(directory, "review.md", baseline);
    await register(request, documentPath);
    await changeOnDisk(request, directory, first);
    await changeOnDisk(request, directory, second);
    await changeOnDisk(request, directory, latest);
    await openMarkdownFile(page, documentPath);

    const deleted = page.getByTestId("revision-deletion");
    const words = deleted.filter({ hasText: "fragile wording" });
    const paragraph = deleted.filter({ hasText: removedParagraph });
    await expect(deleted).toHaveCount(2);
    await expect(words).toHaveAttribute("data-revision-number", "1");
    await expect(paragraph).toHaveAttribute("data-revision-number", "2");
    const paragraphSeparation = await paragraph.evaluate((element) => {
      const removedLines = element.firstElementChild?.getClientRects();
      const next = element.nextSibling;
      if (!removedLines?.length || !next)
        throw new Error("The removed paragraph or following text is missing");
      const nextRange = document.createRange();
      nextRange.selectNodeContents(next);
      return {
        removedText: element.textContent,
        nextLineBelowDeletion:
          nextRange.getBoundingClientRect().top >=
          removedLines[removedLines.length - 1].bottom,
      };
    });
    expect(paragraphSeparation).toMatchObject({ nextLineBelowDeletion: true });
    await expect(
      page.getByTestId("revision-change-marker").filter({ hasText: "Deleted" }),
    ).toHaveCount(0);

    for (const key of ["Enter", "Space"]) {
      await words.focus();
      await words.press(key);
      await expect(page.getByTestId("revision-dialog")).toBeVisible();
      await expect(page.getByTestId("revision-before")).toContainText(
        "fragile wording",
      );
      await page.getByTestId("revision-dialog-close").click();
    }
    await chooseRevision(page, 1);
    await expect(deleted).toHaveCount(1);
    await expect(words).toBeVisible();
    await chooseRevision(page, 2);
    await expect(deleted).toHaveCount(1);
    await expect(paragraph).toBeVisible();
    await page.getByTestId("revision-toggle").click();
    await expect(deleted).toHaveCount(0);
    await page.getByTestId("revision-toggle").click();
    await chooseRevision(page, "all");
    await expect(deleted).toHaveCount(2);

    for (const theme of ["light", "dark"] as const) {
      await page.getByTestId("theme-menu-trigger").click();
      await page.getByTestId(`theme-option-${theme}`).click();
      const appearance = await deleted.evaluateAll((elements) =>
        elements.map((element) => {
          const style = getComputedStyle(element);
          const text = element.firstElementChild;
          if (!text) throw new Error("Deleted text is missing");
          return {
            ink: style.color,
            fill: style.backgroundColor,
            decoration: getComputedStyle(text).textDecorationLine,
          };
        }),
      );
      expect(
        appearance.every((item) => item.decoration === "line-through"),
      ).toBe(true);
      expect(appearance[0].ink).not.toBe(appearance[1].ink);
      expect(appearance[0].fill).not.toBe(appearance[1].fill);
      await expect(page.getByTestId("revision-highlight")).toHaveCSS(
        "box-shadow",
        "none",
      );
      for (const [viewport, width] of [
        ["desktop", 1440],
        ["narrow", 390],
      ] as const) {
        await page.setViewportSize({ width, height: 900 });
        await expect(paragraph).toBeVisible();
        const layout = await paragraph.evaluate((element) => ({
          lineCount: element.firstElementChild?.getClientRects().length ?? 0,
          overflows: document.documentElement.scrollWidth > window.innerWidth,
        }));
        expect(layout.overflows).toBe(false);
        if (viewport === "narrow") expect(layout.lineCount).toBeGreaterThan(1);
        if (process.env.ROUGHDRAFT_CAPTURE_SCREENSHOTS === "1") {
          const screenshotDirectory = path.resolve(
            import.meta.dirname,
            "../../../.context/ui-state-screenshots",
          );
          fs.mkdirSync(screenshotDirectory, { recursive: true });
          await page.screenshot({
            path: path.join(
              screenshotDirectory,
              `revisions-${viewport}-${theme}-inline-deletions.png`,
            ),
            animations: "disabled",
          });
        }
        logE2eEvent("revision-highlights.inline-deletion-rendered", {
          theme,
          viewport,
          ...layout,
          appearance,
        });
      }
    }
    expect(readProjectFile(directory, "review.md")).toBe(latest);

    await richTextEditor(page).focus();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+End" : "Control+End",
    );
    await page.keyboard.insertText(" Added during review.");
    await expect
      .poll(() => readProjectFile(directory, "review.md"))
      .toContain("Added during review.");
    const saved = readProjectFile(directory, "review.md");
    expect(saved).not.toContain("fragile wording");
    expect(saved).not.toContain(removedParagraph);
    await page.reload();
    await expect(deleted).toHaveCount(2);
    logE2eEvent("revision-highlights.inline-deletion-save", {
      deletedTextRestored: false,
      visibleDeletionsAfterReload: await deleted.count(),
    });
  });

  test("shows deletion context and leaves overlapping review comments in control", async ({
    page,
    request,
  }) => {
    const baseline =
      '# Review\n\nThe {==reviewed phrase==}{>>Please clarify this.<<}{id="c1" by="user" at="2026-04-23T18:00:00.000Z"} stays. Remove the obsolete clause.\n';
    const overlap =
      '# Review\n\nThe {==reviewed wording==}{>>Please clarify this.<<}{id="c1" by="user" at="2026-04-23T18:00:00.000Z"} stays. Remove the obsolete clause.\n';
    const latest =
      '# Review\n\nThe {==reviewed wording==}{>>Please clarify this.<<}{id="c1" by="user" at="2026-04-23T18:00:00.000Z"} stays.\n';
    const documentPath = writeProjectFile(directory, "review.md", baseline);
    await register(request, documentPath);
    await changeOnDisk(request, directory, overlap);
    await changeOnDisk(request, directory, latest);
    await openMarkdownFile(page, documentPath);

    await expect(
      page.getByTestId("revision-highlight").filter({ hasText: "wording" }),
    ).toHaveAttribute("data-revision-number", "1");
    await expect(page.getByTestId("revision-deletion")).toHaveAttribute(
      "data-revision-number",
      "2",
    );
    await page
      .getByTestId("revision-highlight")
      .filter({ hasText: "wording" })
      .click();
    await expect(page.getByTestId("comment-thread-c1")).toBeVisible();
    await expect(page.getByTestId("revision-dialog")).toHaveCount(0);

    await page.getByTestId("revision-deletion").click();
    await expect(page.getByTestId("revision-dialog")).toBeVisible();
    await expect(page.getByTestId("revision-before")).toContainText(
      "obsolete clause",
    );
    await expect(page.getByTestId("revision-after")).not.toContainText(
      "obsolete clause",
    );

    if (process.env.ROUGHDRAFT_CAPTURE_SCREENSHOTS === "1") {
      const screenshotDirectory = path.resolve(
        import.meta.dirname,
        "../../../.context/ui-state-screenshots",
      );
      fs.mkdirSync(screenshotDirectory, { recursive: true });
      for (const theme of ["light", "dark"] as const) {
        await page.getByTestId("revision-dialog-close").click();
        await page.getByTestId("theme-menu-trigger").click();
        await page.getByTestId(`theme-option-${theme}`).click();
        for (const [viewport, width] of [
          ["desktop", 1440],
          ["narrow", 390],
        ] as const) {
          await page.setViewportSize({ width, height: 900 });
          await expect(
            page
              .getByTestId("revision-highlight")
              .filter({ hasText: "wording" }),
          ).toBeVisible();
          await page.screenshot({
            path: path.join(
              screenshotDirectory,
              `revisions-${viewport}-${theme}-overlap.png`,
            ),
            animations: "disabled",
          });
          await page.getByTestId("revision-deletion").click();
          await expect(page.getByTestId("revision-dialog")).toBeVisible();
          await page.screenshot({
            path: path.join(
              screenshotDirectory,
              `revisions-${viewport}-${theme}-deletion.png`,
            ),
            animations: "disabled",
          });
          await page.getByTestId("revision-dialog-close").click();
        }
        await page.getByTestId("revision-deletion").click();
      }
    }
    expect(readProjectFile(directory, "review.md")).toBe(latest);
    logE2eEvent("revision-highlights.deletion-review-overlap", {
      preserved: true,
    });
  });
});
