import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

const original = [
  "# Theme review",
  "",
  "Read this document in either appearance.",
  "",
  "- **Decision:** Follow the system theme.",
  "- Check `colorScheme` and [review history](https://example.com/history).",
  "",
  "```js",
  'const appearance = "dark";',
  "```",
  "",
].join("\n");

// The existing rich-text mount/reload path normalizes whitespace even without
// theme actions. Use its observed stable output for visual mode switching;
// the preference test below keeps the original bytes in two real code views.
const richTextFixture = [
  "# Theme review",
  "Read this document in either appearance.",
  "",
  "- **Decision:** Follow the system theme.",
  "  ",
  "- Check `colorScheme` and [review history](https://example.com/history).",
  "  ",
  "",
  "```js",
  'const appearance = "dark";',
  "```",
  "",
].join("\n");

async function expectScheme(page: Page, scheme: "light" | "dark") {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        dark: document.documentElement.classList.contains("dark"),
        native: getComputedStyle(document.documentElement).colorScheme,
      })),
    )
    .toEqual({ dark: scheme === "dark", native: scheme });
}

async function expectDarkSurface(surface: Locator) {
  await expect(surface).toBeVisible();
  // Canvas resolves both RGB and OKLCH computed colors in the real browser.
  const rgb = await surface.evaluate((element) => {
    let current: Element | null = element;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("A canvas color context is required");
    while (current) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = getComputedStyle(current).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      const pixel = Array.from(context.getImageData(0, 0, 1, 1).data);
      if (pixel[3] === 255) return pixel.slice(0, 3);
      current = current.parentElement;
    }
    throw new Error("No opaque background found for the visible surface");
  });
  expect(Math.max(...rgb), "dark surface RGB channels").toBeLessThan(128);
}

async function chooseTheme(page: Page, name: "System" | "Light" | "Dark") {
  const trigger = page.getByTestId("theme-menu-trigger");
  await expect(trigger).toHaveAccessibleName("Appearance");
  await expect(trigger).toHaveRole("combobox");
  await trigger.click();
  const option = page.getByTestId(`theme-option-${name.toLowerCase()}`);
  await expect(option).toHaveRole("option");
  await expect(option).toHaveAccessibleName(name);
  await option.click();
}

async function sourceLinkContrast(page: Page) {
  return page.getByTestId("markdown-code-editor").evaluate((editor) => {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.textContent?.includes("https://example.com/history")) {
      node = walker.nextNode();
    }
    const token = node?.parentElement;
    if (!token) throw new Error("The source URL token is missing");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("A canvas color context is required");
    const pixel = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    const foreground = pixel(getComputedStyle(token).color);
    let surface: Element | null = token;
    let background: number[] = [];
    while (surface) {
      background = pixel(getComputedStyle(surface).backgroundColor);
      if (background[3] === 255) break;
      surface = surface.parentElement;
    }
    if (!surface) throw new Error("The source URL has no opaque background");
    const luminance = (rgba: number[]) => {
      const [r, g, b] = rgba.slice(0, 3).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const light = luminance(foreground);
    const dark = luminance(background);
    return {
      foreground,
      background,
      ratio: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05),
    };
  });
}

test.describe("theme preferences", () => {
  let projectDir: string;
  let documentPath: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("theme");
    documentPath = writeProjectFile(projectDir, "theme-review.md", original);
  });

  test.afterEach(async ({ context }) => {
    await Promise.all(context.pages().map((page) => page.close()));
    removeMarkdownProject(projectDir);
  });

  test("follows system changes live with dark inbox and both real editor views", async ({
    page,
    request,
  }, testInfo) => {
    writeProjectFile(projectDir, "theme-review.md", richTextFixture);
    const registered = await request.post("/api/reviews", {
      data: { documentPath },
    });
    expect(registered.status()).toBe(201);
    const review = await registered.json();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    const inbox = page.getByTestId("review-home");
    await expect(inbox).toBeVisible();
    logE2eEvent("theme.system-initial", {
      root: await page.evaluate(() => ({
        dark: document.documentElement.classList.contains("dark"),
        native: getComputedStyle(document.documentElement).colorScheme,
      })),
    });
    await expectScheme(page, "dark");
    const card = page.getByTestId("review-home-card").filter({
      has: page.locator(
        `[data-testid="review-home-item"][href="${review.route}"]`,
      ),
    });
    await expectDarkSurface(card);
    await expect(page.getByTestId("theme-menu-trigger")).toHaveAccessibleName(
      "Appearance",
    );
    await page.screenshot({
      path: testInfo.outputPath("theme-dark-inbox-desktop.png"),
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(card).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: testInfo.outputPath("theme-dark-inbox-mobile.png"),
      animations: "disabled",
    });

    const loadedAt = await page.evaluate(() => performance.timeOrigin);
    await page.emulateMedia({ colorScheme: "light" });
    await expectScheme(page, "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expectScheme(page, "dark");
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(loadedAt);

    await page.setViewportSize({ width: 1280, height: 720 });
    await openMarkdownFile(page, documentPath);
    await expect(page.getByTestId("document-save-status")).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    await expect(page.getByTestId("rich-text-editor")).toContainText(
      "Read this document in either appearance.",
    );
    await expectDarkSurface(page.getByTestId("document-content-card"));
    await page.screenshot({
      path: testInfo.outputPath("theme-dark-rich-text-desktop.png"),
      animations: "disabled",
    });
    await page.getByTestId("document-editor-view-toggle").click();
    await expect(page.getByTestId("markdown-code-editor")).toContainText(
      "# Theme review",
    );
    await expect(page.getByTestId("document-save-status")).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await expectDarkSurface(page.getByTestId("markdown-code-editor"));
    const contrast = await sourceLinkContrast(page);
    logE2eEvent("theme.source-link-contrast", contrast);
    expect(
      contrast.ratio,
      "source URL contrast on dark editor",
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: testInfo.outputPath("theme-dark-code-mobile.png"),
      animations: "disabled",
    });
    expect(readProjectFile(projectDir, "theme-review.md")).toBe(
      richTextFixture,
    );
    logE2eEvent("theme.system-and-editors", {
      mediaChangesWithoutReload: 2,
      editorModes: ["rich-text", "code"],
      markdownUnchanged: true,
    });
  });

  test("persists an explicit preference and restores system following with invalid-value fallback", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    // Keep preference persistence independent of the existing rich-text
    // mount/reload normalization reproduced without any theme interaction.
    await openMarkdownFile(page, documentPath, "code");
    await expect(page.getByTestId("document-save-status")).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    // The missing control is a distinct RED from the missing native scheme.
    await expect(page.getByTestId("theme-menu-trigger")).toBeVisible();
    const otherTab = await page.context().newPage();
    await otherTab.emulateMedia({ colorScheme: "light" });
    await openMarkdownFile(otherTab, documentPath, "code");
    await expectScheme(otherTab, "light");
    await chooseTheme(page, "Dark");
    await expectScheme(page, "dark");
    await expectScheme(otherTab, "dark");
    expect(
      await page.evaluate(() => localStorage.getItem("roughdraft:theme")),
    ).toBe("dark");
    await page.reload();
    await expectScheme(page, "dark");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.emulateMedia({ colorScheme: "light" });
    await expectScheme(page, "dark");

    await chooseTheme(page, "System");
    await expectScheme(page, "light");
    await expectScheme(otherTab, "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expectScheme(page, "dark");
    await chooseTheme(page, "Light");
    await expectScheme(page, "light");

    await page.evaluate(() => {
      localStorage.setItem("roughdraft:theme", "invalid-preference");
    });
    await page.reload();
    await expectScheme(page, "dark");
    expect(
      await page.evaluate(
        () => document.documentElement.dataset.themePreference,
      ),
    ).toBe("system");
    await page.emulateMedia({ colorScheme: "light" });
    await expectScheme(page, "light");
    await expect(page.getByTestId("document-save-status")).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    await expect(otherTab.getByTestId("document-save-status")).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    expect(readProjectFile(projectDir, "theme-review.md")).toBe(original);
    logE2eEvent("theme.preference-restored", {
      explicitDarkSurvivedReload: true,
      explicitDarkIgnoredLightMedia: true,
      systemResumedMediaFollowing: true,
      otherTabFollowedStoredPreference: true,
      invalidPreferenceFellBack: true,
      markdownUnchanged: true,
    });
  });
});
