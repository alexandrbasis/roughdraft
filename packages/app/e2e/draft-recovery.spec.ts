import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  appendInCodeEditor,
  codeEditor,
  createMarkdownProject,
  documentSaveStatus,
  logE2eEvent,
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
    // A slow typing run can start autosave mid-edit. Deliver the disk fault
    // after typing so later keystrokes cannot replace the failed-save status.
    let finishTyping!: () => void;
    const typingFinished = new Promise<void>((resolve) => {
      finishTyping = resolve;
    });
    const failPut = async (route: import("@playwright/test").Route) => {
      if (route.request().method() === "PUT") {
        await typingFinished;
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
    const failedSave = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/markdown-file" &&
        response.request().method() === "PUT" &&
        response.status() === 503,
    );
    finishTyping();
    await failedSave;
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

    // Closing a tab can cancel its final mirror PUT after an older revision
    // reached the server. Keep that copy to exercise revision-safe cleanup.
    await page.route("**/api/reviews/drafts", async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      const draft = route.request().postDataJSON().draft;
      if (draft.content.includes(draftText)) {
        logE2eEvent("closedtab.source-put-aborted", {
          revision: draft.revision,
        });
        return route.abort("connectionfailed");
      }
      await route.continue();
    });
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
    await expect(newTab.getByTestId("draft-recovery-other")).toBeEnabled();
    const remaining = await newTab.request.get(
      `/api/reviews/drafts?${new URLSearchParams({ documentPath: fs.realpathSync(filePath) })}`,
    );
    const { drafts } = await remaining.json();
    expect(drafts).toHaveLength(1);
    expect(drafts[0].content).not.toContain(draftText);
    logE2eEvent("closedtab.saved-with-retained-source", {
      status: await documentSaveStatus(newTab).getAttribute("aria-label"),
      retainedDrafts: drafts.length,
    });
  });

  test("recovers a server-confirmed draft in a separate browser @smoke", async ({
    page,
    browser,
    baseURL,
  }) => {
    const original = "# Review\n\nOriginal body.\n";
    const filePath = writeProjectFile(
      projectDir,
      "separate-browser.md",
      original,
    );
    const draftText = "Server copy survives browser storage isolation.";
    // Inject a transport failure for the disk save; draft API calls hit the real server.
    await page.route("**/api/markdown-file?**", async (route) => {
      if (route.request().method() === "PUT")
        await route.abort("connectionfailed");
      else await route.continue();
    });
    await openMarkdownFile(page, filePath, "code");
    await appendInCodeEditor(page, `\n${draftText}\n`);
    const draftUrl = `/api/reviews/drafts?${new URLSearchParams({ documentPath: fs.realpathSync(filePath) })}`;
    await expect
      .poll(async () => {
        const response = await page.request.get(draftUrl);
        if (
          !response.ok() ||
          !response.headers()["content-type"]?.includes("application/json")
        )
          return false;
        const payload = await response.json();
        return payload.drafts.some((draft: { content: string }) =>
          draft.content.includes(draftText),
        );
      })
      .toBe(true);
    expect(readProjectFile(projectDir, "separate-browser.md")).toBe(original);
    logE2eEvent("draft.server-confirmed", { diskUnchanged: true });
    await page.close();

    const separateBrowser = await browser.newContext({ baseURL });
    try {
      const recoveryPage = await separateBrowser.newPage();
      await openMarkdownFile(recoveryPage, filePath, "code");
      await expect(
        recoveryPage.getByTestId("draft-recovery-other"),
      ).toBeVisible();
      expect(
        await recoveryPage.evaluate(() =>
          Object.keys(localStorage).filter((key) =>
            key.startsWith("roughdraft:draft:v1:"),
          ),
        ),
      ).toEqual([]);
      await recoveryPage.getByTestId("draft-recovery-other").click();
      await expect(codeEditor(recoveryPage)).toContainText(draftText);
      await expect(
        recoveryPage.getByTestId("draft-recovery-notice"),
      ).toContainText("server");
      expect(readProjectFile(projectDir, "separate-browser.md")).toBe(original);
      await expect(documentSaveStatus(recoveryPage)).toHaveAttribute(
        "aria-label",
        "Unsaved changes",
      );
      await recoveryPage.getByTestId("draft-recovery-save").click();
      await expect
        .poll(() => readProjectFile(projectDir, "separate-browser.md"))
        .toContain(draftText);
      await expect
        .poll(
          async () =>
            (await (await recoveryPage.request.get(draftUrl)).json()).drafts
              .length,
        )
        .toBe(0);
      logE2eEvent("draft.separate-browser-saved", { serverDraftsRemaining: 0 });
    } finally {
      await separateBrowser.close();
    }
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
