import fs from "node:fs";
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

test("typing during an in-flight autosave keeps the later text pending @smoke", async ({
  page,
}) => {
  const projectDir = createMarkdownProject("iteration-inflight");
  let firstPutStarted!: () => void;
  const firstPut = new Promise<void>((resolve) => {
    firstPutStarted = resolve;
  });
  let releaseFirstPut!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseFirstPut = resolve;
  });
  let intercepted = false;
  await page.route("**/api/markdown-file?**", async (route) => {
    if (route.request().method() !== "PUT" || intercepted) {
      await route.continue();
      return;
    }
    intercepted = true;
    logE2eEvent("iteration.first-put-held", {
      requestHasFirstEdit:
        route.request().postData()?.includes("First local edit.") ?? false,
    });
    firstPutStarted();
    await release;
    await route.continue();
  });

  try {
    const filePath = writeProjectFile(
      projectDir,
      "inflight.md",
      "# Review iteration\n\nOriginal body.\n",
    );
    await openMarkdownFile(page, filePath, "code");
    await appendInCodeEditor(page, "\nFirst local edit.\n");
    logE2eEvent("iteration.first-edit-entered", {
      diskHasFirstEdit: readProjectFile(projectDir, "inflight.md").includes(
        "First local edit.",
      ),
    });
    await firstPut;
    await appendInCodeEditor(page, "\nSecond local edit while saving.\n");
    await expect(codeEditor(page)).toContainText(
      "Second local edit while saving.",
    );
    logE2eEvent("iteration.second-edit-entered", {
      diskHasSecondEdit: readProjectFile(projectDir, "inflight.md").includes(
        "Second local edit while saving.",
      ),
    });
    releaseFirstPut();

    try {
      await expect
        .poll(() => readProjectFile(projectDir, "inflight.md"))
        .toContain("Second local edit while saving.");
    } finally {
      const disk = readProjectFile(projectDir, "inflight.md");
      logE2eEvent("iteration.after-first-put", {
        diskHasFirstEdit: disk.includes("First local edit."),
        diskHasSecondEdit: disk.includes("Second local edit while saving."),
        bannerVisible: await page
          .getByTestId("draft-recovery-notice")
          .isVisible(),
        saveStatus: await documentSaveStatus(page).getAttribute("aria-label"),
      });
    }
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    await expect(page.getByTestId("draft-recovery-notice")).toHaveCount(0);
    logE2eEvent("iteration.second-edit-saved", {
      saveStatus: await documentSaveStatus(page).getAttribute("aria-label"),
    });
  } finally {
    releaseFirstPut();
    removeMarkdownProject(projectDir);
  }
});

test("an external edit keeps both editions and restores the discarded reviewed draft @smoke", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const projectDir = createMarkdownProject("iteration-external");
  const original = [
    "# Review iteration",
    "",
    'Keep {++clear wording++}{id="s1" by="user" at="2026-04-23T18:00:00.000Z"} here.',
    "",
    'The {==first point==}{>>Preserve the first comment<<}{id="c1" by="user" at="2026-04-23T18:01:00.000Z"} remains under review.',
    "",
    'The {==second point==}{>>Preserve the second comment<<}{id="c2" by="user" at="2026-04-23T18:02:00.000Z"} remains under review.',
    "",
  ].join("\n");
  const external = `${original}External editor chose this paragraph.\n`;
  const failPut = async (route: import("@playwright/test").Route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "offline" }),
    });
  };
  await page.route("**/api/markdown-file?**", failPut);

  try {
    const filePath = writeProjectFile(projectDir, "external.md", original);
    const documentPath = fs.realpathSync(filePath);
    const draftUrl = `/api/reviews/drafts?${new URLSearchParams({ documentPath })}`;
    const historyUrl = `/api/reviews/history?${new URLSearchParams({ documentPath })}`;
    const revisionsUrl = `/api/reviews/revisions?${new URLSearchParams({ documentPath })}`;
    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("comment-rail-c1")).toContainText(
      "Preserve the first comment",
    );
    await page.getByTestId("comment-rail-s1-action-accept").click();
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Save failed",
    );

    // Confirm the browser's accepted suggestion and both comments have reached
    // the real server draft endpoint before reloading the page.
    let localDraft = "";
    await expect
      .poll(async () => {
        const response = await page.request.get(draftUrl);
        if (!response.ok()) return false;
        const { drafts } = (await response.json()) as {
          drafts: Array<{ content: string }>;
        };
        localDraft = drafts.at(-1)?.content ?? "";
        return (
          localDraft.includes("Keep clear wording here.") &&
          localDraft.includes("Preserve the first comment") &&
          localDraft.includes("Preserve the second comment") &&
          !localDraft.includes("{++")
        );
      })
      .toBe(true);
    expect(readProjectFile(projectDir, "external.md")).toBe(original);
    fs.writeFileSync(filePath, external);
    await page.reload();
    await expect(page.getByTestId("draft-recovery-notice")).toBeVisible();
    expect(readProjectFile(projectDir, "external.md")).toBe(external);

    await page.getByTestId("draft-recovery-keep-disk").click();
    await expect(page.getByTestId("draft-recovery-notice")).toHaveCount(0);
    expect(readProjectFile(projectDir, "external.md")).toBe(external);
    await page.unroute("**/api/markdown-file?**", failPut);

    let recoveryId = "";
    await expect
      .poll(async () => {
        const response = await page.request.get(historyUrl);
        if (!response.ok()) return false;
        const { snapshots } = (await response.json()) as {
          snapshots: Array<{ id: string; content: string }>;
        };
        const recovered = snapshots.find(
          (snapshot) => snapshot.content === localDraft,
        );
        recoveryId = recovered?.id ?? "";
        return Boolean(recovered);
      })
      .toBe(true);
    const snapshotResponse = await page.request.get(
      `/api/reviews/snapshots/${recoveryId}?${new URLSearchParams({ documentPath })}`,
    );
    expect(snapshotResponse.ok()).toBe(true);
    expect((await snapshotResponse.json()).content).toBe(localDraft);
    const revisionsBeforeRestore = (
      (await (await page.request.get(revisionsUrl)).json()) as {
        revisions: Array<{ number: number }>;
      }
    ).revisions.length;
    logE2eEvent("iteration.both-editions-retained", {
      diskHasExternalText: readProjectFile(projectDir, "external.md").includes(
        "External editor chose this paragraph.",
      ),
      recoveryId,
      completedVersions: revisionsBeforeRestore,
    });

    await page.getByTestId("revision-history").click();
    await page.getByTestId("revision-history-recovery-tab").click();
    await page.getByTestId(`revision-recovery-${recoveryId}`).click();
    await page.getByTestId("revision-preview-source").click();
    await expect(page.getByTestId("revision-history-source")).toContainText(
      "Preserve the first comment",
    );
    await expect(page.getByTestId("revision-history-source")).toContainText(
      "Preserve the second comment",
    );
    await page.getByTestId("revision-history-restore").click();
    await page.getByTestId("revision-restore-confirm-button").click();
    await expect
      .poll(() => readProjectFile(projectDir, "external.md"))
      .toBe(localDraft);
    await expect
      .poll(
        async () =>
          (
            (await (await page.request.get(revisionsUrl)).json()) as {
              revisions: Array<{ number: number }>;
            }
          ).revisions.length,
      )
      .toBe(revisionsBeforeRestore);

    const reopened = await context.newPage();
    try {
      await openMarkdownFile(reopened, filePath);
      await expect(reopened.getByTestId("comment-rail-c1")).toContainText(
        "Preserve the first comment",
      );
      await expect(reopened.getByTestId("comment-rail-c2")).toContainText(
        "Preserve the second comment",
      );
      expect(readProjectFile(projectDir, "external.md")).toBe(localDraft);
    } finally {
      await reopened.close();
    }
  } finally {
    await page.unroute("**/api/markdown-file?**", failPut);
    removeMarkdownProject(projectDir);
  }
});

test("accepting all suggestions saves them and preserves existing comments @smoke", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const projectDir = createMarkdownProject("iteration-autosave");
  try {
    const filePath = writeProjectFile(
      projectDir,
      "iteration.md",
      [
        "# Review iteration",
        "",
        'Keep {++clear wording++}{id="s1" by="user" at="2026-04-23T18:00:00.000Z"} here.',
        "",
        'Remove {--drafty --}{id="s2" by="user" at="2026-04-23T18:01:00.000Z"}there.',
        "",
        'The {==original point==}{>>Preserve this discussion<<}{id="c1" by="user" at="2026-04-23T18:01:00.000Z"} remains under review.',
        "",
        'Another {==review note==}{>>Keep the second comment<<}{id="c2" by="user" at="2026-04-23T18:02:00.000Z"} remains open.',
        "",
      ].join("\n"),
    );
    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("comment-rail-c1")).toContainText(
      "Preserve this discussion",
    );
    await expect(
      page.getByTestId("comment-rail-s1-action-accept"),
    ).toBeVisible();

    logE2eEvent("iteration.before-accept", {
      diskHasSuggestion: readProjectFile(projectDir, "iteration.md").includes(
        "{++",
      ),
    });
    await page.getByTestId("comment-rail-s1-action-accept").click();
    await page.getByTestId("comment-rail-s2-action-accept").click();

    await expect
      .poll(() => readProjectFile(projectDir, "iteration.md"))
      .toContain("Keep clear wording here.");
    await expect
      .poll(() => readProjectFile(projectDir, "iteration.md"))
      .toContain("Remove there.");
    const saved = readProjectFile(projectDir, "iteration.md");
    expect(saved).toContain("Preserve this discussion");
    expect(saved).toContain("Keep the second comment");
    expect(saved).toContain("original point");
    expect(saved).not.toContain("{++");
    expect(saved).not.toContain("{--");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    logE2eEvent("iteration.after-accept", {
      diskHasComment: saved.includes("Preserve this discussion"),
      diskHasSuggestion: saved.includes("{++"),
      saveStatus: await documentSaveStatus(page).getAttribute("aria-label"),
    });

    await page.reload();
    await expect(page.getByTestId("comment-rail-c1")).toContainText(
      "Preserve this discussion",
    );
    await expect(page.getByTestId("comment-rail-c2")).toContainText(
      "Keep the second comment",
    );
    await expect(page.getByTestId("draft-recovery-notice")).toHaveCount(0);
  } finally {
    removeMarkdownProject(projectDir);
  }
});

test("editing after Done starts a new user iteration @smoke", async ({
  page,
  request,
}) => {
  const projectDir = createMarkdownProject("iteration-after-done");
  try {
    const filePath = writeProjectFile(
      projectDir,
      "again.md",
      "# Next iteration\n\nOriginal text.\n",
    );
    const userIterations = async () => {
      const response = await request.get("/api/reviews/document", {
        params: { documentPath: filePath },
      });
      expect(response.ok()).toBe(true);
      const { iterations } = (await response.json()) as {
        iterations: Array<{ actor: string; number: number; content: string }>;
      };
      return iterations.filter((iteration) => iteration.actor === "user");
    };

    await openMarkdownFile(page, filePath, "code");
    await appendInCodeEditor(page, "\nFirst completed edit.\n");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    await page.getByTestId("review-handoff-button").click();
    await expect(page.getByTestId("review-handoff-button")).toHaveText(
      "Not sent, but saved",
    );
    await expect.poll(async () => (await userIterations()).length).toBe(1);
    const first = (await userIterations())[0];
    expect(first.number).toBe(2);
    expect(first.content).toContain("First completed edit.");
    await expect(codeEditor(page)).toContainText("First completed edit.");
    expect(readProjectFile(projectDir, "again.md")).toContain(
      "First completed edit.",
    );

    await appendInCodeEditor(page, "\nSecond completed edit.\n");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    await expect
      .poll(() => readProjectFile(projectDir, "again.md"))
      .toContain("Second completed edit.");
    await expect(page.getByTestId("review-handoff-button")).toHaveText(
      "I'm done",
    );
    await page.getByTestId("review-handoff-button").click();
    await expect.poll(async () => (await userIterations()).length).toBe(2);
    const second = (await userIterations())[1];
    expect(second.number).toBe(3);
    expect(second.content).toContain("First completed edit.");
    expect(second.content).toContain("Second completed edit.");
    logE2eEvent("iteration.second-done-completed", {
      numbers: [first.number, second.number],
    });
  } finally {
    removeMarkdownProject(projectDir);
  }
});

test("opening the same document URL after Done starts the next review", async ({
  page,
  request,
}) => {
  const projectDir = createMarkdownProject("iteration-same-url");
  try {
    const filePath = writeProjectFile(
      projectDir,
      "same-url.md",
      "# Same URL\n\nOriginal text.\n",
    );
    await openMarkdownFile(page, filePath, "code");
    await appendInCodeEditor(page, "\nFirst review edit.\n");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    await page.getByTestId("review-handoff-button").click();
    await expect(page.getByTestId("review-handoff-button")).toHaveText(
      "Not sent, but saved",
    );

    // The agent writes to the same file and reopens its already-visible URL.
    // That open request must begin a fresh review without a manual page reload.
    const agentEdition = `${readProjectFile(projectDir, "same-url.md")}\nAgent revision.\n`;
    fs.writeFileSync(filePath, agentEdition);
    const response = await request.post("/api/open-request", {
      data: { path: filePath, url: page.url() },
    });
    expect(response.ok()).toBe(true);
    expect(await response.json()).toEqual({ delivered: true });
    await expect(page.getByTestId("review-handoff-button")).toHaveText(
      /^(Approve|I'm done)$/,
    );
    await expect(codeEditor(page)).toContainText("Agent revision.");
    await page.getByTestId("review-handoff-button").click();
    await expect
      .poll(async () => {
        const review = await request.get("/api/reviews/document", {
          params: { documentPath: filePath },
        });
        if (!review.ok()) return 0;
        const { iterations } = (await review.json()) as {
          iterations: Array<{ actor: string; content: string }>;
        };
        return iterations.filter(
          (iteration) =>
            iteration.actor === "user" &&
            iteration.content.includes("Agent revision."),
        ).length;
      })
      .toBe(1);
  } finally {
    removeMarkdownProject(projectDir);
  }
});
