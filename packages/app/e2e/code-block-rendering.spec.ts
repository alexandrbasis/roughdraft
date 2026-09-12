import {
  expect,
  type Locator,
  type Page,
  test,
  type TestInfo,
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

// Select across syntax-token spans through the browser's real selection API.
// Keyboard editing and the selection menu must then use the normal editor path.
async function selectSourceText(
  page: Page,
  source: Locator,
  text: string,
  collapseToEnd = false,
) {
  await richTextEditor(page).focus();
  await source.evaluate(
    (element, selectionTarget) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const nodes: Node[] = [];
      let current = walker.nextNode();
      while (current) {
        nodes.push(current);
        current = walker.nextNode();
      }
      const fullText = nodes.map((node) => node.textContent).join("");
      const start = fullText.indexOf(selectionTarget.text);
      if (start < 0) {
        throw new Error(`Source text was not found: ${selectionTarget.text}`);
      }
      const range = document.createRange();
      const end = start + selectionTarget.text.length;
      let offset = 0;
      let hasStart = false;
      for (const node of nodes) {
        const nextOffset = offset + (node.textContent?.length ?? 0);
        if (!hasStart && start <= nextOffset) {
          range.setStart(node, start - offset);
          hasStart = true;
        }
        if (hasStart && end <= nextOffset) {
          range.setEnd(node, end - offset);
          break;
        }
        offset = nextOffset;
      }
      if (selectionTarget.collapseToEnd) range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    },
    { text, collapseToEnd },
  );
}

async function expectRenderedDiagram(block: Locator) {
  const image = block.getByTestId("mermaid-rendered-svg");
  await expect(image).toBeVisible();
  await expect(image).toHaveRole("img");
  await expect(image).toHaveAccessibleName("Mermaid diagram");
  await expect(image).toHaveAttribute("src", /^data:image\/svg\+xml/);
  await expect(image).toHaveJSProperty("complete", true);
  await expect
    .poll(() =>
      image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(40);
  await expect
    .poll(() =>
      image.evaluate((element) => (element as HTMLImageElement).naturalHeight),
    )
    .toBeGreaterThan(20);
  return image;
}

async function chooseTheme(page: Page, theme: "system" | "light" | "dark") {
  await page.getByTestId("theme-menu-trigger").click();
  await page.getByTestId(`theme-option-${theme}`).click();
  if (theme !== "system") {
    await expectAppliedTheme(page, theme);
  }
}

async function expectAppliedTheme(page: Page, theme: "light" | "dark") {
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.classList.contains("dark")),
    )
    .toBe(theme === "dark");
}

async function syntaxTokenColor(page: Page) {
  return page.getByTestId("code-block").evaluate((element) => {
    const token = Array.from(element.getElementsByTagName("span")).find(
      (span) => span.style.getPropertyValue("--shiki-light"),
    );
    return token ? getComputedStyle(token).color : null;
  });
}

async function captureCodeState(page: Page, testInfo: TestInfo, name: string) {
  if (!process.env.CODE_RENDERING_SCREENSHOTS) return;
  await page.screenshot({
    path: testInfo.outputPath(`${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
}

test.describe("code block presentation and editable source", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("code-rendering");
  });

  test.afterEach(async ({ context }) => {
    await Promise.all(context.pages().map((page) => page.close()));
    removeMarkdownProject(projectDir);
  });

  test("highlights TypeScript and TSX while preserving whitespace and unknown code", async ({
    page,
  }) => {
    const typescript =
      "interface Config {\n  enabled: boolean;\n\n  label: string;\n}";
    const tsx =
      'export const Badge = () => (\n  <span title="Ready">Ready</span>\n);';
    const unknown = "  <literal> & untouched\n\n\tindented();  ";
    const original = [
      "Code samples.",
      "",
      "```typescript",
      typescript,
      "```",
      "",
      "```tsx",
      tsx,
      "```",
      "",
      "```unknown-roughdraft-language",
      unknown,
      "```",
      "",
    ].join("\n");
    const filePath = writeProjectFile(projectDir, "syntax.md", original);
    await openMarkdownFile(page, filePath, "rich-text");

    for (const [language, text] of [
      ["typescript", typescript],
      ["tsx", tsx],
      ["unknown-roughdraft-language", unknown],
    ]) {
      const block = page.locator(
        `[data-testid="code-block"][data-code-language="${language}"]`,
      );
      await expect(block).toBeVisible();
      expect(await block.textContent()).toBe(text);
      if (language !== "unknown-roughdraft-language") {
        await expect(block).toHaveClass(/\bshiki\b/);
        await expect
          .poll(() =>
            block.evaluate(
              (element) =>
                Array.from(element.getElementsByTagName("span")).filter(
                  (span) =>
                    span.style.getPropertyValue("--shiki-light") &&
                    span.style.getPropertyValue("--shiki-dark"),
                ).length,
            ),
          )
          .toBeGreaterThan(0);
      }
    }
    await page.reload();
    await expect(page.getByTestId("code-block")).toHaveCount(3);
    expect(readProjectFile(projectDir, "syntax.md")).toBe(original);
    logE2eEvent("code-rendering.syntax-whitespace-preserved", {
      highlightedLanguages: 2,
      unknownLanguages: 1,
    });
  });

  test("renders Mermaid, saves a source edit, and reloads the edited diagram @smoke", async ({
    page,
  }) => {
    let writes = 0;
    page.on("request", (request) => {
      if (
        request.method() === "PUT" &&
        new URL(request.url()).pathname === "/api/markdown-file"
      ) {
        writes += 1;
      }
    });
    const original = [
      "Diagram source.",
      "",
      "```mermaid",
      "flowchart LR",
      '  START["Start"] --> DONE["Done"]',
      "",
      '  DONE --> ARCHIVE["Archive"]',
      "```",
      "",
    ].join("\n");
    const filePath = writeProjectFile(projectDir, "diagram-edit.md", original);
    await openMarkdownFile(page, filePath, "rich-text");
    const block = page.getByTestId("mermaid-code-block");
    const image = await expectRenderedDiagram(block);
    const initialSource = await image.getAttribute("src");
    await expect(block.getByTestId("mermaid-view-diagram")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await block.getByTestId("mermaid-view-source").click();
    const source = block.getByTestId("mermaid-source-panel");
    await expect(source).toBeVisible();
    await selectSourceText(page, source, "Done", true);
    await page.keyboard.insertText(" now");
    await expect
      .poll(() => readProjectFile(projectDir, "diagram-edit.md"))
      .toContain("{++ now++}");
    const saved = readProjectFile(projectDir, "diagram-edit.md");
    expect(saved).toContain('\n\n  DONE --> ARCHIVE["Archive"]\n```\n');
    expect(saved).not.toContain("data:image/svg");
    expect(saved).not.toContain("<svg");
    logE2eEvent("code-rendering.source-edit-saved", { changes: 1 });
    await block.getByTestId("mermaid-view-diagram").click();
    await expectRenderedDiagram(block);
    await expect(image).not.toHaveAttribute("src", initialSource ?? "");

    await page.reload();
    await expectRenderedDiagram(page.getByTestId("mermaid-code-block"));
    await page.getByTestId("suggestion-thread-s1").click();
    await expect(page.getByTestId("mermaid-source-panel")).toBeVisible();
    await expect(page.getByTestId("mermaid-source-panel")).toContainText(
      "Done now",
    );
    expect(readProjectFile(projectDir, "diagram-edit.md")).toBe(saved);
    await page.getByTestId("comment-rail-s1-action-accept").click();
    await expect
      .poll(() => readProjectFile(projectDir, "diagram-edit.md"))
      .toContain('DONE["Done now"]');
    expect(readProjectFile(projectDir, "diagram-edit.md")).not.toContain("{++");
    await page.reload();
    await expectRenderedDiagram(page.getByTestId("mermaid-code-block"));
    expect(writes).toBe(2);
    logE2eEvent("code-rendering.edit-save-reload", {
      file: "diagram-edit.md",
      acceptedSuggestions: 1,
      writes,
    });
  });

  test("opens invalid Mermaid source and renders it after the missing node is typed", async ({
    page,
  }, testInfo) => {
    const filePath = writeProjectFile(
      projectDir,
      "repair.md",
      [
        "Repair this diagram.",
        "",
        "```mermaid",
        "flowchart LR",
        "  A -->",
        "```",
        "",
      ].join("\n"),
    );
    await openMarkdownFile(page, filePath, "rich-text");
    const block = page.getByTestId("mermaid-code-block");
    await expect(block.getByTestId("mermaid-render-error")).toContainText(
      "Check the Mermaid syntax below",
    );
    const source = block.getByTestId("mermaid-source-panel");
    await expect(source).toBeVisible();
    await expect(richTextEditor(page)).toHaveAttribute(
      "contenteditable",
      "true",
    );
    await captureCodeState(page, testInfo, "mermaid-invalid-source");
    await selectSourceText(page, source, "A -->", true);
    await page.keyboard.insertText(" B");
    await expect(block.getByTestId("mermaid-render-error")).toHaveCount(0);
    await expect(block.getByTestId("mermaid-view-diagram")).toBeEnabled();
    await block.getByTestId("mermaid-view-diagram").click();
    await expectRenderedDiagram(block);
    await expect
      .poll(() => readProjectFile(projectDir, "repair.md"))
      .toContain("{++ B++}");
    logE2eEvent("code-rendering.invalid-source-repaired", { rendered: true });
  });

  test("manual and system themes update diagrams and code colors without writing the file", async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: "light" });
    const original = [
      "Theme sample.",
      "",
      "```ts",
      'const appearance = "ready";',
      "```",
      "",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
      "",
    ].join("\n");
    const filePath = writeProjectFile(projectDir, "themes.md", original);
    const writes: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "PUT" &&
        new URL(request.url()).pathname === "/api/markdown-file"
      ) {
        writes.push(request.method());
      }
    });
    await openMarkdownFile(page, filePath, "rich-text");
    const block = page.getByTestId("mermaid-code-block");
    const image = await expectRenderedDiagram(block);
    await expect.poll(() => syntaxTokenColor(page)).not.toBeNull();
    const lightColor = await syntaxTokenColor(page);
    const lightDiagram = await image.getAttribute("src");
    await captureCodeState(page, testInfo, "mermaid-light");

    await chooseTheme(page, "dark");
    await expectRenderedDiagram(block);
    await expect(image).not.toHaveAttribute("src", lightDiagram ?? "");
    await expect.poll(() => syntaxTokenColor(page)).not.toBe(lightColor);
    const darkDiagram = await image.getAttribute("src");
    await captureCodeState(page, testInfo, "mermaid-dark");

    await page.emulateMedia({ colorScheme: "dark" });
    await chooseTheme(page, "light");
    await expectRenderedDiagram(block);
    await expect(image).not.toHaveAttribute("src", darkDiagram ?? "");
    await expect.poll(() => syntaxTokenColor(page)).toBe(lightColor);
    await chooseTheme(page, "system");
    await expectAppliedTheme(page, "dark");
    await expectRenderedDiagram(block);
    await expect.poll(() => syntaxTokenColor(page)).not.toBe(lightColor);

    await page.emulateMedia({ colorScheme: "light" });
    await expectAppliedTheme(page, "light");
    await expect.poll(() => syntaxTokenColor(page)).toBe(lightColor);
    await expectRenderedDiagram(block);
    if (process.env.CODE_RENDERING_SCREENSHOTS) {
      await page.setViewportSize({ width: 390, height: 844 });
      await captureCodeState(page, testInfo, "mermaid-narrow");
      await page.setViewportSize({ width: 1280, height: 720 });
    }
    await block.getByTestId("mermaid-view-source").click();
    await expect(block.getByTestId("mermaid-source-panel")).toBeVisible();
    await block.getByTestId("mermaid-view-diagram").click();
    await expectRenderedDiagram(block);
    await page.reload();
    await expectRenderedDiagram(page.getByTestId("mermaid-code-block"));
    expect(writes).toEqual([]);
    expect(readProjectFile(projectDir, "themes.md")).toBe(original);
    logE2eEvent("code-rendering.theme-no-writes", { writes: writes.length });
  });

  test("comments on Mermaid source, preserves whitespace, and reveals its anchor after reload", async ({
    page,
  }) => {
    const original = [
      "Comment this diagram.",
      "",
      "```mermaid",
      "flowchart LR",
      '  START["Start"] --> REVIEW["Review step"]',
      "",
      '  REVIEW --> DONE["Done"]',
      "```",
      "",
    ].join("\n");
    const filePath = writeProjectFile(projectDir, "comment.md", original);
    await openMarkdownFile(page, filePath, "rich-text");
    const block = page.getByTestId("mermaid-code-block");
    await expectRenderedDiagram(block);
    await block.getByTestId("mermaid-view-source").click();
    await selectSourceText(
      page,
      block.getByTestId("mermaid-source-panel"),
      "Review step",
    );
    await page.getByTestId("selection-menu-action-comment").click();
    await page
      .getByTestId("comment-rail-c1-editor")
      .fill("Keep this step explicit.");
    await page.getByTestId("comment-rail-c1-action-save").click();
    await expect
      .poll(() => readProjectFile(projectDir, "comment.md"))
      .toContain('{==Review step==}{>>Keep this step explicit.<<}{id="c1"');
    const saved = readProjectFile(projectDir, "comment.md");
    expect(saved).toContain('\n\n  REVIEW --> DONE["Done"]\n```\n');
    logE2eEvent("code-rendering.source-comment-saved", { comments: 1 });

    await page.reload();
    await expectRenderedDiagram(page.getByTestId("mermaid-code-block"));
    await page.getByTestId("comment-thread-c1").click();
    await expect(page.getByTestId("mermaid-source-panel")).toBeVisible();
    await expect(page.getByTestId("mermaid-source-panel")).toContainText(
      "Review step",
    );
    expect(readProjectFile(projectDir, "comment.md")).toBe(saved);
    logE2eEvent("code-rendering.comment-save-reload", { file: "comment.md" });
  });

  test("keeps Mermaid HTML and click directives inert in the rendered image", async ({
    page,
  }) => {
    const externalOrigin = "https://roughdraft-mermaid-resource.invalid";
    const original = [
      "Untrusted diagram labels.",
      "",
      "```mermaid",
      "flowchart LR",
      `  A["<img src='${externalOrigin}/tracker.png' onerror='window.__mermaidScriptExecuted=true'>"] --> B["Review"]`,
      `  click B "${externalOrigin}/link"`,
      "```",
      "",
    ].join("\n");
    const filePath = writeProjectFile(projectDir, "inert-diagram.md", original);
    const externalRequests: string[] = [];
    const popups: Page[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith(externalOrigin)) {
        externalRequests.push(request.url());
      }
    });
    page.on("popup", (popup) => popups.push(popup));
    await openMarkdownFile(page, filePath, "rich-text");
    const block = page.getByTestId("mermaid-code-block");
    const image = await expectRenderedDiagram(block);
    const documentUrl = page.url();
    await image.click();
    expect(page.url()).toBe(documentUrl);
    expect(popups).toEqual([]);
    expect(externalRequests).toEqual([]);
    expect(
      await block.evaluate((element) => ({
        links: element.getElementsByTagName("a").length,
        images: element.getElementsByTagName("img").length,
        scriptExecuted: "__mermaidScriptExecuted" in window,
      })),
    ).toEqual({ links: 0, images: 1, scriptExecuted: false });
    expect(readProjectFile(projectDir, "inert-diagram.md")).toBe(original);
    logE2eEvent("code-rendering.untrusted-diagram-inert", {
      externalRequests: externalRequests.length,
      popups: popups.length,
    });
  });
});
