import { expect, test } from "@playwright/test";
import {
  logE2eEvent,
  createMarkdownProject,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

test.describe("Markdown source preservation", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("preservation");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("saves and reloads annotated fenced code with its whitespace intact", async ({
    page,
  }) => {
    const annotatedCode = [
      "```ts",
      [
        "const key = (patientId: string) => `timeline:v1:",
        "$",
        "{patientId}`",
      ].join(""),
      "",
      "export async function invalidate(redis: Redis, patientId: string) {",
      '  {==await redis.del(key(patientId))==}{>>Check invalidation<<}{id="c1" by="user" at="2026-09-08T10:00:00.000Z"}',
      "}",
      "```",
    ].join("\n");
    const original = ["Source fixture.", "", annotatedCode, ""].join("\n");
    const filePath = writeProjectFile(
      projectDir,
      "annotated-code.md",
      original,
    );

    await openMarkdownFile(page, filePath, "rich-text");
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "Check invalidation",
    );
    await richTextEditor(page).click();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Home" : "Control+Home",
    );
    await page.keyboard.type("Edited ");
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+S" : "Control+S",
    );

    await expect
      .poll(() => readProjectFile(projectDir, "annotated-code.md"))
      .toContain("{++Edited++}");
    expect(readProjectFile(projectDir, "annotated-code.md")).toContain(
      annotatedCode,
    );

    await page.reload();
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "Check invalidation",
    );
    expect(readProjectFile(projectDir, "annotated-code.md")).toContain(
      annotatedCode,
    );

    logE2eEvent("markdown-preservation.annotated-code-save-load", {
      file: "annotated-code.md",
      bytes: Buffer.byteLength(original),
    });
  });

  test("saves and reloads GFM task lists as one item per source line", async ({
    page,
  }) => {
    const taskList = [
      "## Reviews",
      "- [ ] Claude reviewed",
      "- [x] Codex reviewed",
    ].join("\n");
    const original = [taskList, "", "Source footer.", ""].join("\n");
    const filePath = writeProjectFile(projectDir, "tasks.md", original);

    await openMarkdownFile(page, filePath, "rich-text");
    await richTextEditor(page).click();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+End" : "Control+End",
    );
    await page.keyboard.type(" saved");
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+S" : "Control+S",
    );

    await expect
      .poll(() => readProjectFile(projectDir, "tasks.md"))
      .toContain("{++saved++}");
    expect(readProjectFile(projectDir, "tasks.md")).toContain(taskList);

    await page.reload();
    // TaskItem recreates these native controls; this exact selector is an allowlisted stable exception.
    const checkboxes = richTextEditor(page).locator('input[type="checkbox"]');
    await expect(checkboxes).toHaveCount(2);
    await expect(checkboxes.nth(0)).not.toBeChecked();
    await expect(checkboxes.nth(1)).toBeChecked();
    expect(readProjectFile(projectDir, "tasks.md")).toContain(taskList);

    logE2eEvent("markdown-preservation.task-list-save-load", {
      file: "tasks.md",
      bytes: Buffer.byteLength(original),
    });
  });
});
