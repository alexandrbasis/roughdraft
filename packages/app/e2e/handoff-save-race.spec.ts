import { expect, test } from "@playwright/test";
import {
  appendInCodeEditor,
  codeEditor,
  createMarkdownProject,
  documentSaveStatus,
  fileConflictNotice,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test("Done does not complete an earlier edition while newer typing remains editable", async ({
  page,
  request,
}) => {
  const projectDir = createMarkdownProject("handoff-save-race");
  let releaseDonePut!: () => void;
  const heldPutRelease = new Promise<void>((resolve) => {
    releaseDonePut = resolve;
  });
  let signalDonePut!: () => void;
  const donePutStarted = new Promise<void>((resolve) => {
    signalDonePut = resolve;
  });
  let held = false;

  try {
    const filePath = writeProjectFile(
      projectDir,
      "review.md",
      "# Handoff race\n\nOriginal text.\n",
    );
    await openMarkdownFile(page, filePath, "code");
    await appendInCodeEditor(page, "\nFirst edit.\n");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    expect(readProjectFile(projectDir, "review.md")).toContain("First edit.");

    // The first PUT was the normal autosave. Hold Done's separate PUT at the
    // real HTTP boundary so editing can happen while completion is pending.
    await page.route("**/api/markdown-file?**", async (route) => {
      if (route.request().method() !== "PUT" || held) {
        await route.continue();
        return;
      }
      held = true;
      logE2eEvent("handoff-race.done-put-held", {
        hasFirstEdit: route.request().postData()?.includes("First edit."),
      });
      signalDonePut();
      await heldPutRelease;
      await route.continue();
    });

    await page.getByTestId("review-handoff-button").click();
    await donePutStarted;
    const editor = codeEditor(page);
    const editableDuringHandoff =
      (await editor.getAttribute("contenteditable")) !== "false";
    if (editableDuringHandoff) {
      await appendInCodeEditor(page, "\nNewer edit during Done.\n");
      await expect(editor).toContainText("Newer edit during Done.");
    }
    logE2eEvent("handoff-race.edit-during-done", {
      editableDuringHandoff,
      editorHasNewerText: await editor
        .textContent()
        .then((text) => text?.includes("Newer edit during Done.")),
    });
    releaseDonePut();

    await expect(page.getByTestId("review-handoff-button")).toHaveText(
      "Not sent, but saved",
    );
    const document = await request.get("/api/reviews/document", {
      params: { documentPath: filePath },
    });
    expect(document.ok()).toBe(true);
    const { iterations } = (await document.json()) as {
      iterations: Array<{ actor: string; content: string }>;
    };
    const completedUserEdition = iterations
      .filter((iteration) => iteration.actor === "user")
      .at(-1);
    logE2eEvent("handoff-race.completed", {
      editableDuringHandoff,
      completedHasNewerText: completedUserEdition?.content.includes(
        "Newer edit during Done.",
      ),
      diskHasNewerText: readProjectFile(projectDir, "review.md").includes(
        "Newer edit during Done.",
      ),
    });
    if (editableDuringHandoff) {
      expect(completedUserEdition?.content).toContain(
        "Newer edit during Done.",
      );
      await expect(editor).toContainText("Newer edit during Done.");
    }
  } finally {
    releaseDonePut();
    removeMarkdownProject(projectDir);
  }
});

test("an older save acknowledgement does not clear a newer external conflict", async ({
  page,
}) => {
  const projectDir = createMarkdownProject("watcher-save-race");
  let releaseFirstResponse!: () => void;
  const firstResponseRelease = new Promise<void>((resolve) => {
    releaseFirstResponse = resolve;
  });
  let signalFirstWrite!: () => void;
  const firstWriteDone = new Promise<void>((resolve) => {
    signalFirstWrite = resolve;
  });
  let releaseLaterPut!: () => void;
  const laterPutRelease = new Promise<void>((resolve) => {
    releaseLaterPut = resolve;
  });
  let laterPuts = 0;
  let firstPutHeld = false;

  try {
    const filePath = writeProjectFile(
      projectDir,
      "review.md",
      "# Watcher race\n\nInitial text.\n",
    );
    await openMarkdownFile(page, filePath, "code");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    const firstResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === "/api/markdown-file",
    );
    await page.route("**/api/markdown-file?**", async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      if (firstPutHeld) {
        laterPuts += 1;
        await laterPutRelease;
        await route.continue();
        return;
      }
      firstPutHeld = true;
      const response = await route.fetch();
      signalFirstWrite();
      await firstResponseRelease;
      await route.fulfill({ response });
    });

    await appendInCodeEditor(page, "\nFirst local edit.\n");
    await firstWriteDone;
    expect(readProjectFile(projectDir, "review.md")).toContain(
      "First local edit.",
    );
    await appendInCodeEditor(page, "\nSecond local edit.\n");
    // Leave the newer edition pending while the first save is unresolved.
    await page.waitForTimeout(600);
    writeProjectFile(
      projectDir,
      "review.md",
      "# Watcher race\n\nExternal editor chose this text.\n",
    );
    await expect(fileConflictNotice(page)).toBeVisible();
    // The poller restarts when conflict state changes. Stop later polls so a
    // fresh read of B cannot mask the effect of the older A acknowledgement.
    await page.route("**/api/markdown-file/events?**", (route) =>
      route.abort(),
    );
    logE2eEvent("watcher-race.foreign-change-seen", {
      localHasSecondEdit: (await codeEditor(page).textContent())?.includes(
        "Second local edit.",
      ),
      diskHasExternalEdit: readProjectFile(projectDir, "review.md").includes(
        "External editor chose this text.",
      ),
    });

    releaseFirstResponse();
    await firstResponse;
    // Any queued newer PUT is still held. The fix may keep that queue paused
    // while the conflict remains, so do not wait for a second request.
    await page.waitForTimeout(100);
    const conflictStillVisible = await fileConflictNotice(page).isVisible();
    logE2eEvent("watcher-race.after-stale-ack", {
      conflictStillVisible,
      laterPuts,
      diskHasExternalEdit: readProjectFile(projectDir, "review.md").includes(
        "External editor chose this text.",
      ),
    });
    expect(conflictStillVisible).toBe(true);
    await expect(codeEditor(page)).toContainText("Second local edit.");
  } finally {
    releaseFirstResponse();
    releaseLaterPut();
    removeMarkdownProject(projectDir);
  }
});
