import fs from "node:fs";
import path from "node:path";
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
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
  completedAt: string | null;
  actor: "agent" | "user" | "unknown";
  author?: string;
}

interface RecoveryPoint {
  id: string;
  content: string;
  createdAt: string;
  reason: string;
}

async function revisionHistory(
  request: APIRequestContext,
  documentPath: string,
) {
  const response = await request.get("/api/reviews/revisions", {
    params: { documentPath },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as {
    revisions: Revision[];
    recoveryPoints: RecoveryPoint[];
  };
}

async function revisions(request: APIRequestContext, documentPath: string) {
  return (await revisionHistory(request, documentPath)).revisions;
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
  await register(request, documentPath);
  await expect
    .poll(async () => (await revisions(request, documentPath)).at(-1)?.content)
    .toBe(content);
}

async function chooseRevision(page: Page, number: number | "all") {
  await page.getByTestId("revision-filter").click();
  await page.getByTestId("revision-filter-all").click();
  if (number !== "all") {
    const options = page
      .getByTestId("revision-filter-popover")
      .getByTestId(/^revision-filter-\d+$/);
    for (const option of await options.all()) {
      if (
        (await option.getAttribute("data-testid")) !==
        `revision-filter-${number}`
      )
        await option.click();
    }
  }
  await page.keyboard.press("Escape");
}

test.describe("document revision highlights", () => {
  let directory: string;

  test.beforeEach(() => {
    directory = createMarkdownProject("revisions");
  });

  test.afterEach(() => {
    removeMarkdownProject(directory);
  });

  for (const mode of ["suggesting", "editing"] as const) {
    test(`${mode} lets clicks edit colored revision text without opening comparison @smoke`, async ({
      page,
      request,
    }) => {
      const baseline = "# Editable revision\n\nThe old wording stays here.\n";
      const changed = "# Editable revision\n\nThe new wording stays here.\n";
      const documentPath = writeProjectFile(directory, "review.md", baseline);
      await register(request, documentPath);
      await changeOnDisk(request, directory, changed);
      await openMarkdownFile(page, documentPath);
      if (mode === "editing") {
        await page.getByTestId("document-mode-trigger").click();
        await page.getByTestId("document-mode-editing").click();
      }

      const highlight = page
        .getByTestId("revision-highlight")
        .filter({ hasText: "new" });
      await expect(highlight).toBeVisible();
      await highlight.click();
      logE2eEvent("revision-highlights.colored-text-click", {
        mode,
        comparisonCount: await page.getByTestId("revision-dialog").count(),
        caretInHighlight: await highlight.evaluate((element) =>
          element.contains(window.getSelection()?.anchorNode ?? null),
        ),
      });
      await expect(page.getByTestId("revision-dialog")).toHaveCount(0);
      await expect(richTextEditor(page)).toBeFocused();
      expect(
        await highlight.evaluate((element) => {
          const selection = window.getSelection();
          return (
            selection?.isCollapsed && element.contains(selection.anchorNode)
          );
        }),
      ).toBe(true);

      await page.keyboard.insertText(" Edited.");
      const editedText = await richTextEditor(page).textContent();
      expect(editedText).toContain("Edited.");
      await expect
        .poll(() => readProjectFile(directory, "review.md"))
        .toContain("Edited.");
      await page.reload();
      await expect(richTextEditor(page)).toHaveText(editedText ?? "");
      logE2eEvent("revision-highlights.colored-text-edit-saved", {
        mode,
        editedFileReloaded: true,
      });
    });
  }

  test("colors the complete selected history version against its predecessor @smoke", async ({
    page,
    request,
  }) => {
    const baseline = "Title\n\nA red cat.\n\nplain\n\nRemoved paragraph.\n";
    const changed = "# Title\n\nA green cat.\n\n**plain**\n";
    const current = "# Title\n\nA blue cat.\n\n**plain**\n";
    const documentPath = writeProjectFile(directory, "review.md", baseline);
    await register(request, documentPath);
    await changeOnDisk(request, directory, changed);
    await changeOnDisk(request, directory, current);
    await openMarkdownFile(page, documentPath);
    await page.getByTestId("revision-history").click();
    await page.getByTestId("revision-history-2").click();
    const preview = page.getByTestId("revision-history-preview");
    await expect(
      preview.getByTestId("revision-highlight").filter({ hasText: "green" }),
    ).toBeVisible();
    await expect(
      preview.getByTestId("revision-highlight").filter({ hasText: "plain" }),
    ).toBeVisible();
    await expect(
      preview.getByTestId("revision-structure-change"),
    ).toContainText("Paragraph → Heading 1");
    await expect(
      preview.getByTestId("revision-deletion").filter({ hasText: "red" }),
    ).toBeVisible();
    await expect(
      preview
        .getByTestId("revision-deletion")
        .filter({ hasText: "Removed paragraph." }),
    ).toBeVisible();
    const colored = preview.locator("[data-revision-number]"); // selector-check-ignore: all colored decorations must identify the selected version, including structure labels.
    for (const item of await colored.all()) {
      await expect(item).toHaveAttribute("data-revision-number", "2");
      await expect(item).toHaveClass(/revision-color-1/);
    }
    await expect(preview.locator(".ProseMirror")).toHaveAttribute(
      "contenteditable",
      "false",
    );
    expect(readProjectFile(directory, "review.md")).toBe(current);
    logE2eEvent("revision.history-complete-comparison", {
      selectedRevision: 2,
      predecessor: 1,
      latestRevision: 3,
      coloredElements: await colored.count(),
      unchangedFile: true,
    });
    await page.getByTestId("revision-history-1").click();
    await expect(preview.getByTestId("revision-highlight")).toHaveCount(0);
    await expect(preview.getByTestId("revision-deletion")).toHaveCount(0);
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
    ).toEqual([1]);
    await changeOnDisk(request, directory, first);
    await changeOnDisk(request, directory, second);
    const saved = await revisions(request, documentPath);
    expect(
      saved.map(({ number, content, source }) => ({ number, content, source })),
    ).toEqual([
      { number: 1, content: baseline, source: "baseline" },
      { number: 2, content: first, source: "external" },
      { number: 3, content: second, source: "external" },
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

    await chooseRevision(page, 2);
    await expect(page.getByTestId("revision-highlight")).toHaveCount(1);
    await expect(page.getByTestId("revision-highlight")).toHaveAttribute(
      "data-revision-number",
      "2",
    );
    await chooseRevision(page, 3);
    await expect(page.getByTestId("revision-highlight")).toHaveAttribute(
      "data-revision-number",
      "3",
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
    await page.getByTestId("revision-filter").click();
    await expect(page.getByTestId("revision-filter-popover")).toContainText(
      "0 changes shown",
    );
    await expect(page.getByTestId("revision-filter-latest")).toBeDisabled();
    await page.keyboard.press("Escape");

    await changeOnDisk(request, directory, changed);
    await expect(page.getByTestId("rich-text-editor")).toContainText(
      "updated wording",
    );
    await expect(
      page.getByTestId("revision-highlight").filter({ hasText: "updated" }),
    ).toHaveAttribute("data-revision-number", "2");
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
    await expect(gamma).toHaveAttribute("data-revision-number", "3");
    await chooseRevision(page, 2);
    await expect(
      page.getByTestId("revision-highlight").filter({ hasText: "gamma" }),
    ).toHaveCount(0);
    await chooseRevision(page, 3);
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
    await expect(words).toHaveAttribute("data-revision-number", "2");
    await expect(paragraph).toHaveAttribute("data-revision-number", "3");
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

    // Removed text is a passive ghost: the physical click passes to the editor.
    await words.click({ force: true });
    await expect(page.getByTestId("revision-dialog")).toHaveCount(0);
    await expect(words).not.toHaveAttribute("role", "button");
    await expect(words).not.toHaveAttribute("tabindex", "0");
    await chooseRevision(page, 2);
    await page.getByTestId("revision-next").click();
    await page.getByTestId("revision-details").click();
    await expect(page.getByTestId("revision-dialog")).toBeVisible();
    await expect(page.getByTestId("revision-before")).toContainText(
      "fragile wording",
    );
    await page.getByTestId("revision-dialog-close").click();
    await chooseRevision(page, 2);
    await expect(deleted).toHaveCount(1);
    await expect(words).toBeVisible();
    await chooseRevision(page, 3);
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
    ).toHaveAttribute("data-revision-number", "2");
    await expect(page.getByTestId("revision-deletion")).toHaveAttribute(
      "data-revision-number",
      "3",
    );
    await page
      .getByTestId("revision-highlight")
      .filter({ hasText: "wording" })
      .click();
    // The same comment can appear in the side rail or the responsive dock.
    const comment = page
      .getByTestId(/^comment-(rail|banner)-c1$/)
      .filter({ visible: true });
    await expect(comment).toBeVisible();
    await expect(comment).toContainText("Please clarify this.");
    await expect(page.getByTestId("revision-dialog")).toHaveCount(0);

    // Removed text is a passive ghost: the physical click passes to the editor.
    await page.getByTestId("revision-deletion").click({ force: true });
    await expect(page.getByTestId("revision-dialog")).toHaveCount(0);
    await chooseRevision(page, 3);
    await page.getByTestId("revision-next").click();
    await page.getByTestId("revision-details").click();
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
      await page.getByTestId("revision-dialog-close").click();
      for (const theme of ["light", "dark"] as const) {
        await chooseRevision(page, "all");
        await page.getByTestId("theme-menu-trigger").click();
        await page.getByTestId(`theme-option-${theme}`).click();
        for (const [viewport, width] of [
          ["desktop", 1440],
          ["narrow", 390],
        ] as const) {
          await chooseRevision(page, "all");
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
          await chooseRevision(page, 3);
          await page.getByTestId("revision-next").click();
          await page.getByTestId("revision-details").click();
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
      }
    }
    expect(readProjectFile(directory, "review.md")).toBe(latest);
    logE2eEvent("revision-highlights.deletion-review-overlap", {
      preserved: true,
    });
  });

  test("combines chosen versions, clears them all, and applies the latest preset", async ({
    page,
    request,
  }) => {
    const documentPath = writeProjectFile(directory, "review.md", "Start.\n");
    await register(request, documentPath);
    await changeOnDisk(request, directory, "Start. One.\n");
    await changeOnDisk(request, directory, "Start. One. Two.\n");
    await changeOnDisk(request, directory, "Start. One. Two. Three.\n");
    await openMarkdownFile(page, documentPath);
    await expect(page.getByTestId("revision-highlight")).toHaveCount(3);

    await page.getByTestId("revision-filter").click();
    await page.getByTestId("revision-filter-3").click();
    await expect(page.getByTestId("revision-highlight")).toHaveCount(2);
    await page.getByTestId("revision-filter-2").click();
    await expect(page.getByTestId("revision-highlight")).toHaveCount(1);
    await page.getByTestId("revision-filter-3").click();
    await expect(page.getByTestId("revision-highlight")).toHaveCount(2);
    await expect(page.getByTestId("revision-count")).toContainText("2 changes");

    await page.getByTestId("revision-filter-latest").click();
    await expect(page.getByTestId("revision-highlight")).toHaveCount(1);
    await expect(page.getByTestId("revision-highlight")).toHaveAttribute(
      "data-revision-number",
      "4",
    );
    await page.getByTestId("revision-filter-4").click();
    await expect(page.getByTestId("revision-highlight")).toHaveCount(0);
    await expect(page.getByTestId("revision-count")).toContainText("0 changes");
    await page.getByTestId("revision-filter-all").click();
    await expect(page.getByTestId("revision-highlight")).toHaveCount(3);
    await page.keyboard.press("Escape");
    expect(readProjectFile(directory, "review.md")).toBe(
      "Start. One. Two. Three.\n",
    );
    logE2eEvent("revision-highlights.multi-filter", {
      selectedChangeCount: 2,
      emptySelectionCount: 0,
      restoredAllCount: 3,
    });
  });

  test("previews the full saved version and restores only after confirmation", async ({
    page,
    request,
  }) => {
    const baseline = "# Earlier\n\nOriginal body.\n";
    const first = "# Earlier\n\nFirst saved body.\n";
    const latest = "# Current\n\nLatest saved body.\n";
    const documentPath = writeProjectFile(directory, "review.md", baseline);
    await register(request, documentPath);
    await changeOnDisk(request, directory, first);
    await changeOnDisk(request, directory, latest);
    await openMarkdownFile(page, documentPath);

    await page.getByTestId("revision-history").click();
    await expect(page.getByTestId("revision-history-dialog")).toBeVisible();
    await expect(page.getByTestId("revision-history-1")).toContainText("V1");
    await expect(page.getByTestId("revision-history-author-1")).toContainText(
      "Agent",
    );
    await expect(page.getByTestId("revision-history-author-3")).toContainText(
      "Agent",
    );
    await expect(page.getByTestId("revision-history-time-3")).not.toBeEmpty();
    await expect(page.getByTestId("revision-history-preview")).toContainText(
      "Latest saved body.",
    );
    await expect(
      page.getByTestId("revision-history-preview").locator(".ProseMirror"),
    ).toHaveAttribute("contenteditable", "false");
    await expect(page.getByTestId("revision-history-restore")).toBeDisabled();
    await expect(
      page.getByTestId("revision-restore-disabled-reason"),
    ).toHaveText("This is already the current document.");
    await page.getByTestId("revision-history-2").click();
    await expect(page.getByTestId("revision-history-restore")).toBeEnabled();
    await expect(page.getByTestId("revision-history-preview")).toContainText(
      "First saved body.",
    );
    await page.getByTestId("revision-preview-source").click();
    await expect(page.getByTestId("revision-history-source")).toHaveText(first);
    await page.getByTestId("revision-preview-reading").click();
    expect(readProjectFile(directory, "review.md")).toBe(latest);
    await page.getByTestId("revision-history-restore").click();
    await expect(page.getByTestId("revision-restore-confirm")).toBeVisible();
    await page
      .getByTestId("revision-restore-confirm")
      .getByRole("button", { name: "Cancel" })
      .click();
    expect(readProjectFile(directory, "review.md")).toBe(latest);

    let releaseSave = () => {};
    const saveHold = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let saveRequested = false;
    await page.route("**/api/markdown-file?*", async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      saveRequested = true;
      await saveHold;
      await route.continue();
    });
    try {
      await page.getByTestId("revision-history-restore").click();
      await page.getByTestId("revision-restore-confirm-button").click();
      await expect.poll(() => saveRequested).toBe(true);
      await expect(
        page.getByTestId("revision-restore-confirm-button"),
      ).toHaveText("Restoring…");
      await expect(
        page
          .getByTestId("revision-restore-confirm")
          .getByRole("button", { name: "Cancel" }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("revision-restore-confirm")).toBeVisible();
      await expect(page.getByTestId("revision-history-dialog")).toBeVisible();
      expect(readProjectFile(directory, "review.md")).toBe(latest);
    } finally {
      releaseSave();
    }
    await expect
      .poll(() => readProjectFile(directory, "review.md"))
      .toBe(first);
    await expect
      .poll(async () =>
        (await revisions(request, documentPath)).map(({ number, content }) => ({
          number,
          content,
        })),
      )
      .toEqual([
        { number: 1, content: baseline },
        { number: 2, content: first },
        { number: 3, content: latest },
      ]);
    await expect(page.getByTestId("rich-text-editor")).toContainText(
      "First saved body.",
    );
    logE2eEvent("revision-history.restore-confirmed", {
      selected: 2,
      completedVersionCount: 3,
      previousVersionsPreserved: true,
    });
  });

  test("requires a fresh confirmation when the document changes during restore", async ({
    page,
    request,
  }) => {
    const baseline = "# Restore guard\n\nOriginal.\n";
    const first = "# Restore guard\n\nFirst edit.\n";
    const newest = "# Restore guard\n\nNew external edit.\n";
    const documentPath = writeProjectFile(directory, "review.md", baseline);
    await register(request, documentPath);
    await changeOnDisk(request, directory, first);
    await openMarkdownFile(page, documentPath);

    await page.getByTestId("revision-history").click();
    await page.getByTestId("revision-history-1").click();
    await page.getByTestId("revision-history-restore").click();
    await expect(page.getByTestId("revision-restore-confirm")).toBeVisible();
    await changeOnDisk(request, directory, newest);
    await expect(page.getByTestId("revision-restore-confirm")).toHaveCount(0);
    await expect(page.getByTestId("revision-history-notice")).toContainText(
      "The document changed",
    );
    expect(readProjectFile(directory, "review.md")).toBe(newest);
    expect(
      (await revisions(request, documentPath)).map(({ content }) => content),
    ).toEqual([baseline, first, newest]);
    logE2eEvent("revision-history.stale-confirmation-blocked", {
      unchangedAfterConfirmationInvalidated: true,
    });
  });

  test("previews and restores a discarded browser copy without completing a version", async ({
    page,
    request,
  }) => {
    const baseline = "# Recovery\n\nPublished text.\n";
    const discarded = "# Recovery\n\nDiscarded browser wording.\n";
    const documentPath = writeProjectFile(directory, "review.md", baseline);
    await register(request, documentPath);
    const draft = {
      storageKey: `recovery-test:${documentPath}`,
      content: discarded,
      baseContent: baseline,
      baseVersion: null,
      revision: "discarded-1",
      tabId: "discarded-tab",
      updatedAt: Date.now(),
    };
    const saved = await request.put("/api/reviews/drafts", {
      data: { documentPath, draft },
    });
    expect(saved.ok()).toBe(true);
    const removed = await request.delete("/api/reviews/drafts", {
      data: {
        documentPath,
        tabId: draft.tabId,
        revision: draft.revision,
      },
    });
    expect(removed.ok()).toBe(true);
    const history = await revisionHistory(request, documentPath);
    const recovery = history.recoveryPoints.find(
      (point) => point.content === discarded,
    );
    expect(recovery?.reason).toBe("browser-draft");
    if (!recovery) throw new Error("Discarded browser copy was not retained");
    expect(history.revisions.map(({ number }) => number)).toEqual([1]);

    await openMarkdownFile(page, documentPath);
    await page.getByTestId("revision-history").click();
    await page.getByTestId("revision-history-recovery-tab").click();
    await page.getByTestId(`revision-recovery-${recovery.id}`).click();
    await expect(page.getByTestId("revision-history-preview")).toContainText(
      "Discarded browser wording.",
    );
    await expect(page.getByTestId("revision-history-restore")).toBeEnabled();
    await page.getByTestId("revision-history-restore").click();
    await expect(page.getByTestId("revision-restore-confirm")).toContainText(
      "A new completed version appears only after Done.",
    );
    await page.getByTestId("revision-restore-confirm-button").click();
    await expect
      .poll(() => readProjectFile(directory, "review.md"))
      .toBe(discarded);
    expect(
      (await revisions(request, documentPath)).map(({ number }) => number),
    ).toEqual([1]);
  });

  test("shows when an original edition was first seen, then refreshes its agent handoff", async ({
    page,
    request,
  }) => {
    const documentPath = writeProjectFile(
      directory,
      "review.md",
      "# First edition\n\nNo handoff yet.\n",
    );
    await openMarkdownFile(page, documentPath);
    const original = (await revisions(request, documentPath))[0];
    expect(original).toMatchObject({
      number: 1,
      actor: "unknown",
      completedAt: null,
    });
    await page.getByTestId("revision-history").click();
    await expect(page.getByTestId("revision-history-time-1")).toContainText(
      "First seen",
    );
    await page
      .getByTestId("revision-history-dialog")
      .getByText("Close", { exact: true })
      .click();

    await register(request, documentPath);
    await expect
      .poll(async () => (await revisions(request, documentPath))[0]?.actor)
      .toBe("agent");
    expect((await revisions(request, documentPath))[0]?.id).toBe(original.id);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByTestId("revision-history").click();
    await expect(page.getByTestId("revision-history-author-1")).toContainText(
      "Agent",
    );
    await expect(page.getByTestId("revision-history-time-1")).toContainText(
      "Completed",
    );
  });

  test("provides thirty distinct computed colors in both themes", async ({
    page,
    request,
  }) => {
    const documentPath = writeProjectFile(directory, "review.md", "# Colors\n");
    await register(request, documentPath);
    await openMarkdownFile(page, documentPath);
    for (const theme of ["light", "dark"] as const) {
      await page.getByTestId("theme-menu-trigger").click();
      await page.getByTestId(`theme-option-${theme}`).click();
      const colors = await page.evaluate(() => {
        const host = document.createElement("div");
        host.style.display = "none";
        for (let index = 0; index < 30; index++) {
          const swatch = document.createElement("span");
          swatch.className = `revision-swatch revision-color-${index}`;
          host.append(swatch);
        }
        document.body.append(host);
        const result = [...host.children].map((element) =>
          getComputedStyle(element).getPropertyValue("--revision-fill").trim(),
        );
        host.remove();
        return result;
      });
      expect(new Set(colors).size, `${theme} theme palette`).toBe(30);
      logE2eEvent("revision-colors.palette", { theme, uniqueColors: 30 });
    }
  });
});
