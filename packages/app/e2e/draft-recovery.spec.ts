import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  appendInCodeEditor,
  codeEditor,
  createMarkdownProject,
  documentSaveStatus,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test.describe("durable browser drafts", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("draft-recovery");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("recovers the local draft after a failed save and reload @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "review.md",
      "# Review\n\nOriginal body.\n",
    );
    const failPut = async (route: import("@playwright/test").Route) => {
      if (route.request().method() === "PUT") {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "offline" }),
        });
        return;
      }
      await route.continue();
    };
    await page.route("**/api/markdown-file**", failPut);

    await openMarkdownFile(page, filePath, "code");
    await appendInCodeEditor(page, "\nLocal draft after the failed save.\n");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Save failed",
    );
    expect(readProjectFile(projectDir, "review.md")).toContain(
      "Original body.",
    );

    await page.reload();
    await expect(page.getByTestId("draft-recovery-notice")).toContainText(
      "Recovered local draft",
    );
    await expect(codeEditor(page)).toContainText(
      "Local draft after the failed save.",
    );
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Unsaved changes",
    );

    const screenshotDir = path.join(
      process.cwd(),
      ".context/ui-state-screenshots",
    );
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotDir, "draft-recovery-safe.png"),
      fullPage: false,
    });

    await page.unroute("**/api/markdown-file**", failPut);
    await page.getByTestId("draft-recovery-save").click();
    await expect
      .poll(() => readProjectFile(projectDir, "review.md"))
      .toContain("Local draft after the failed save.");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    await expect(page.getByTestId("draft-recovery-notice")).toHaveCount(0);
  });

  test("recovers a closed tab's unsaved draft in a new tab", async ({
    page,
    context,
  }) => {
    const original = "# Review\n\nOriginal body.\n";
    const filePath = writeProjectFile(projectDir, "closed-tab.md", original);
    const draftText = "Local edits preserved after closing the tab.";
    const failPut = async (route: import("@playwright/test").Route) => {
      if (route.request().method() === "PUT") {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "offline" }),
        });
        return;
      }
      await route.continue();
    };
    await context.route("**/api/markdown-file**", failPut);

    await openMarkdownFile(page, filePath, "code");
    await appendInCodeEditor(page, `\n${draftText}\n`);
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Save failed",
    );
    expect(readProjectFile(projectDir, "closed-tab.md")).toBe(original);
    await page.close();

    const newTab = await context.newPage();
    await openMarkdownFile(newTab, filePath, "code");
    const recoverOther = newTab.getByTestId("draft-recovery-other");
    await expect(recoverOther).toBeVisible();
    await recoverOther.click();
    await expect(codeEditor(newTab)).toContainText(draftText);
    expect(readProjectFile(projectDir, "closed-tab.md")).toBe(original);

    await context.unroute("**/api/markdown-file**", failPut);
    await newTab.getByTestId("draft-recovery-save").click();
    await expect
      .poll(() => readProjectFile(projectDir, "closed-tab.md"))
      .toContain(draftText);
    await expect(documentSaveStatus(newTab)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    await expect(newTab.getByTestId("draft-recovery-notice")).toHaveCount(0);
  });

  test("keeps both versions when disk changed before draft recovery", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "changed.md",
      "# Review\n\nOriginal body.\n",
    );
    let failNextPut = true;
    const failFirstPut = async (route: import("@playwright/test").Route) => {
      if (route.request().method() === "PUT" && failNextPut) {
        failNextPut = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "offline" }),
        });
        return;
      }
      await route.continue();
    };
    await page.route("**/api/markdown-file**", failFirstPut);

    await openMarkdownFile(page, filePath, "code");
    await appendInCodeEditor(page, "\nLocal draft to recover.\n");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Save failed",
    );

    fs.writeFileSync(filePath, "# Review\n\nExternal disk version.\n");
    await page.reload();

    await expect(page.getByTestId("draft-recovery-notice")).toContainText(
      "Disk version changed",
    );
    await expect(codeEditor(page)).toContainText("External disk version.");
    await expect(
      page.getByTestId("draft-recovery-recover-local"),
    ).toBeVisible();
    expect(readProjectFile(projectDir, "changed.md")).toContain(
      "External disk version.",
    );

    await page.getByTestId("draft-recovery-recover-local").click();
    await expect(codeEditor(page)).toContainText("Local draft to recover.");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Save conflict",
    );
    expect(readProjectFile(projectDir, "changed.md")).toContain(
      "External disk version.",
    );

    await page.getByTestId("draft-recovery-overwrite").click();
    await expect
      .poll(() => readProjectFile(projectDir, "changed.md"))
      .toContain("Local draft to recover.");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    await expect(page.getByTestId("draft-recovery-notice")).toHaveCount(0);
  });
});
