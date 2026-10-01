import fs from "node:fs";
import { expect, type Route, test } from "@playwright/test";
import {
  appendInCodeEditor,
  codeEditor,
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

type DraftSummary = { content: string; tabId: string; revision: string };

test("does not offer this tab's older server copy as another browser's draft", async ({
  page,
}) => {
  const projectDir = createMarkdownProject("server-draft-notice");
  const filePath = writeProjectFile(
    projectDir,
    "review.md",
    "# Review\n\nOriginal body.\n",
  );
  const draftUrl = `/api/reviews/drafts?${new URLSearchParams({ documentPath: fs.realpathSync(filePath) })}`;
  let firstPutStarted!: () => void;
  const firstPutSeen = new Promise<void>((resolve) => {
    firstPutStarted = resolve;
  });
  let releaseFirstPut!: () => void;
  const firstPutGate = new Promise<void>((resolve) => {
    releaseFirstPut = resolve;
  });
  let releaseLaterPuts!: () => void;
  const laterPutGate = new Promise<void>((resolve) => {
    releaseLaterPuts = resolve;
  });
  let markdownPutCount = 0;
  const holdMarkdownPuts = async (route: Route) => {
    if (route.request().method() !== "PUT") return route.continue();
    markdownPutCount += 1;
    if (markdownPutCount === 1) {
      firstPutStarted();
      await firstPutGate;
    } else {
      await laterPutGate;
    }
    await route.continue();
  };
  await page.route("**/api/markdown-file?**", holdMarkdownPuts);

  try {
    await openMarkdownFile(page, filePath, "code");
    await appendInCodeEditor(page, "A");
    await firstPutSeen;

    let firstDraft: DraftSummary | undefined;
    await expect
      .poll(async () => {
        const { drafts } = await (await page.request.get(draftUrl)).json();
        firstDraft = drafts.find((draft: DraftSummary) =>
          draft.content.endsWith("Original body.\nA"),
        );
        return !!firstDraft;
      })
      .toBe(true);
    if (!firstDraft) throw new Error("First draft mirror was not observed");

    await appendInCodeEditor(page, "B");
    let newerDraft: DraftSummary | undefined;
    await expect
      .poll(async () => {
        const { drafts } = await (await page.request.get(draftUrl)).json();
        newerDraft = drafts.find((draft: DraftSummary) =>
          draft.content.endsWith("Original body.\nAB"),
        );
        return !!newerDraft;
      })
      .toBe(true);
    if (!newerDraft) throw new Error("Newer draft mirror was not observed");
    logE2eEvent("server-draft.same-tab-newer-mirror", {
      firstRevision: firstDraft.revision,
      newerRevision: newerDraft.revision,
      sameTab: firstDraft.tabId === newerDraft.tabId,
    });
    expect(newerDraft.tabId).toBe(firstDraft.tabId);
    expect(newerDraft.revision).not.toBe(firstDraft.revision);

    const falseDelete = page.waitForResponse(async (response) => {
      if (
        new URL(response.url()).pathname !== "/api/reviews/drafts" ||
        response.request().method() !== "DELETE"
      )
        return false;
      return (await response.json()).deleted === false;
    });
    const refreshedList = page.waitForResponse(async (response) => {
      if (
        new URL(response.url()).pathname !== "/api/reviews/drafts" ||
        response.request().method() !== "GET"
      )
        return false;
      const { drafts } = await response.json();
      return drafts.some(
        (draft: { tabId: string; revision: string }) =>
          draft.tabId === firstDraft.tabId &&
          draft.revision !== firstDraft.revision,
      );
    });
    releaseFirstPut();
    const deleteResponse = await falseDelete;
    const deleteRequest = deleteResponse.request().postDataJSON();
    expect(deleteRequest.revision).toBe(firstDraft.revision);
    const listResponse = await refreshedList;
    const listedDrafts = (await listResponse.json()).drafts;
    logE2eEvent("server-draft.old-revision-delete-false", {
      deleted: (await deleteResponse.json()).deleted,
      deletedRevision: deleteRequest.revision,
      listedOwnRevisions: listedDrafts
        .filter((draft: { tabId: string }) => draft.tabId === firstDraft.tabId)
        .map((draft: { revision: string }) => draft.revision),
    });

    await appendInCodeEditor(page, "C");
    await expect(codeEditor(page)).toContainText("ABC");
    await expect(page.getByTestId("draft-other-notice")).toHaveCount(0);
    logE2eEvent("server-draft.third-edit-no-foreign-notice", {
      noticeVisible: await page.getByTestId("draft-other-notice").isVisible(),
      diskContainsFirstEdit: readProjectFile(projectDir, "review.md").includes(
        "Original body.\nA",
      ),
      diskContainsThirdEdit: readProjectFile(projectDir, "review.md").includes(
        "Original body.\nABC",
      ),
    });
    expect(readProjectFile(projectDir, "review.md")).toContain(
      "Original body.\nA",
    );
  } finally {
    releaseFirstPut();
    releaseLaterPuts();
    if (
      await codeEditor(page)
        .isVisible()
        .catch(() => false)
    ) {
      const editorText = await codeEditor(page).textContent();
      if (editorText?.includes("ABC")) {
        await expect
          .poll(() => readProjectFile(projectDir, "review.md"))
          .toContain("Original body.\nABC");
        logE2eEvent("server-draft.third-edit-saved", {
          diskContainsThirdEdit: readProjectFile(
            projectDir,
            "review.md",
          ).includes("Original body.\nABC"),
        });
      }
    }
    await page.unroute("**/api/markdown-file?**", holdMarkdownPuts);
    await page.close();
    removeMarkdownProject(projectDir);
  }
});
