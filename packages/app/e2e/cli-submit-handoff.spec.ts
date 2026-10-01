import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test("a CLI submit wakes a completed review already open at its friendly route @smoke", async ({
  page,
  request,
}) => {
  const projectDir = createMarkdownProject("cli-submit-handoff");
  const content = "# Agent review\n\nAn edition ready for review.\n";
  const filePath = writeProjectFile(projectDir, "review.md", content);
  const canonicalPath = fs.realpathSync(filePath);
  try {
    const registered = await request.post("/api/reviews", {
      data: { documentPath: canonicalPath },
    });
    expect(registered.status()).toBe(201);
    const { route } = (await registered.json()) as { route: string };

    const firstPoll = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/open-requests" &&
        url.searchParams.get("poll") === "1"
      );
    });
    await page.goto(route);
    await firstPoll;
    await expect(page.getByTestId("rich-text-editor")).toContainText(
      "An edition ready for review.",
    );
    expect(new URL(page.url()).pathname).toBe(route);
    expect(new URL(page.url()).search).toBe("");

    const handoffButton = page.getByTestId("review-handoff-button");
    await expect(handoffButton).toHaveText(/^(Approve|I'm done)$/);
    await handoffButton.click();
    await expect(handoffButton).toHaveText("Not sent, but saved");

    // Match `roughdraft submit`: send an unchanged edition with the current
    // source version, then ask the already-open window to show its review URL.
    const submitQuery = new URLSearchParams({
      projectPath: path.dirname(canonicalPath),
      path: path.basename(canonicalPath),
    });
    const submit = await request.post(`/api/reviews/submit?${submitQuery}`, {
      data: {
        content,
        expectedVersion: createHash("sha256").update(content).digest("hex"),
      },
    });
    expect(submit.status()).toBe(200);
    const submission = (await submit.json()) as {
      documentPath: string;
      route: string;
      editingState: string;
    };
    expect(submission).toMatchObject({
      documentPath: canonicalPath,
      route,
      editingState: "awaiting-review",
    });

    const openRequest = await request.post("/api/open-request", {
      data: { path: canonicalPath, url: page.url() },
    });
    expect(openRequest.ok()).toBe(true);
    const delivery = (await openRequest.json()) as { delivered: boolean };
    logE2eEvent("cli-submit.friendly-route-open-request", {
      route,
      delivered: delivery.delivered,
      completedButton: await handoffButton.innerText(),
    });
    expect(delivery).toEqual({ delivered: true });
    await expect(handoffButton).toHaveText(/^(Approve|I'm done)$/);
    expect(new URL(page.url()).pathname).toBe(route);
  } finally {
    await page.close();
    removeMarkdownProject(projectDir);
  }
});

test("a completed review stays completed after reloading its friendly route @smoke", async ({
  page,
  request,
}) => {
  const projectDir = createMarkdownProject("completed-review-reload");
  const filePath = writeProjectFile(
    projectDir,
    "review.md",
    "# Completed review\n\nReady for the reviewer.\n",
  );
  const canonicalPath = fs.realpathSync(filePath);
  const documentQuery = new URLSearchParams({ documentPath: canonicalPath });
  const reviewQuery = new URLSearchParams({
    projectPath: path.dirname(canonicalPath),
    path: path.basename(canonicalPath),
  });
  const documentUrl = `/api/reviews/document?${documentQuery}`;
  try {
    const registered = await request.post("/api/reviews", {
      data: { documentPath: canonicalPath },
    });
    expect(registered.status()).toBe(201);
    const { route } = (await registered.json()) as { route: string };
    await page.goto(route);
    await expect(page.getByTestId("rich-text-editor")).toContainText(
      "Ready for the reviewer.",
    );

    const handoffButton = page.getByTestId("review-handoff-button");
    await expect(handoffButton).toHaveText(/^(Approve|I'm done)$/);
    await handoffButton.click();
    await expect(handoffButton).toHaveText("Not sent, but saved");

    const completedResponse = await request.get(documentUrl);
    expect(completedResponse.ok()).toBe(true);
    const completed = (await completedResponse.json()) as {
      editingState: string;
      iterations: Array<{ actor: string }>;
    };
    expect(completed.editingState).toBe("completed");
    expect(completed.iterations.at(-1)?.actor).toBe("user");
    const completedCount = completed.iterations.length;
    logE2eEvent("completion-state.before-reload", {
      editingState: completed.editingState,
      iterationCount: completedCount,
      button: await handoffButton.innerText(),
    });

    await page.reload();
    await expect(page.getByTestId("rich-text-editor")).toContainText(
      "Ready for the reviewer.",
    );
    const afterReloadResponse = await request.get(documentUrl);
    expect(afterReloadResponse.ok()).toBe(true);
    const afterReload = (await afterReloadResponse.json()) as typeof completed;
    expect(afterReload.editingState).toBe("completed");
    expect(afterReload.iterations).toHaveLength(completedCount);
    logE2eEvent("completion-state.after-reload", {
      editingState: afterReload.editingState,
      iterationCount: afterReload.iterations.length,
      button: await handoffButton.innerText(),
    });
    await expect(handoffButton).not.toHaveText(/^(Approve|I'm done)$/);

    const watch = request.post("/api/review-events/watch", {
      data: {
        projectPath: path.dirname(canonicalPath),
        path: path.basename(canonicalPath),
        timeoutSeconds: 1,
      },
    });
    await expect
      .poll(async () => {
        const response = await request.get(
          `/api/review-events/status?${reviewQuery}`,
        );
        return (await response.json()).watcherCount as number;
      })
      .toBe(1);
    if (await handoffButton.isEnabled()) await handoffButton.click();
    const watchResult = (await (await watch).json()) as { events: unknown[] };
    expect(watchResult.events).toEqual([]);
    const afterStatusClick = (await (
      await request.get(documentUrl)
    ).json()) as typeof completed;
    expect(afterStatusClick.iterations).toHaveLength(completedCount);

    const editor = page.getByTestId("rich-text-editor").locator(".ProseMirror");
    await editor.click();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+End" : "Control+End",
    );
    await page.keyboard.type(" New local edit.");
    await expect(editor).toContainText("New local edit.");
    await expect(handoffButton).toHaveText(/^(Approve|I'm done)$/);
  } finally {
    await page.close();
    removeMarkdownProject(projectDir);
  }
});
