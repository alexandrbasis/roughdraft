import { expect, type Route, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

// Real HTTP matters here: eight review tabs must leave connections available
// for saving and completion. Each metadata poll must finish as finite JSON.
for (const openReviews of [2, 8]) {
  test(`completes a saved review with ${openReviews} open review tabs`, async ({
    context,
    request,
  }) => {
    const projectDir = createMarkdownProject("handoff-connections");
    const tabs: Awaited<ReturnType<typeof context.newPage>>[] = [];
    const consoleErrors: string[] = [];
    let pendingWatch: ReturnType<typeof request.post> | undefined;
    try {
      writeProjectFile(
        projectDir,
        "review-0.md",
        "# Review 0\n\nReady to send.\n",
      );
      pendingWatch = request.post("/api/review-events/watch", {
        data: {
          projectPath: projectDir,
          path: "review-0.md",
          timeoutSeconds: 15,
        },
      });
      await expect
        .poll(async () => {
          const response = await request.get("/api/review-events/status", {
            params: { projectPath: projectDir, path: "review-0.md" },
          });
          return (await response.json()).watcherCount;
        })
        .toBe(1);

      for (let index = 0; index < openReviews; index++) {
        const filePath = writeProjectFile(
          projectDir,
          `review-${index}.md`,
          `# Review ${index}\n\nReady to send.\n`,
        );
        const tab = await context.newPage();
        tabs.push(tab);
        tab.on("pageerror", (error) => consoleErrors.push(error.message));
        tab.on("console", (message) => {
          if (message.type() === "error") consoleErrors.push(message.text());
        });
        const metadataPoll = tab.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            url.pathname === "/api/markdown-file/events" &&
            url.searchParams.get("poll") === "1"
          );
        });
        await openMarkdownFile(tab, filePath);
        await expect(tab.getByTestId("document-save-status")).toHaveAttribute(
          "aria-label",
          "Saved",
        );
        const pollResponse = await metadataPoll;
        expect(pollResponse.ok()).toBe(true);
        expect(await pollResponse.finished()).toBeNull();
        expect(await pollResponse.json()).toMatchObject({ exists: true });
        if (index === 0) {
          await expect(tab.getByTestId("review-handoff-button")).toBeVisible();
        }
        logE2eEvent("review-handoff.tab-opened", { index });
      }

      const tab = tabs[0];
      if (!tab) throw new Error("The target review tab must be open");
      const button = tab.getByTestId("review-handoff-button");
      await button.click();
      // The out-of-browser client must still reach the server while UI
      // completion is waiting, matching the reported responsive-server state.
      const status = await request.get("/api/status");
      expect(status.ok()).toBe(true);
      logE2eEvent("review-handoff.connections-after-click", {
        openReviews,
        button: await button.innerText(),
        disabled: await button.isDisabled(),
        saveStatus: await tab
          .getByTestId("document-save-status")
          .getAttribute("aria-label"),
        serverResponsive: status.ok(),
        consoleErrors,
      });

      try {
        await expect(button).not.toHaveText("Sending", { timeout: 5_000 });
      } catch (failure) {
        const watchStatus = await request.get("/api/review-events/status", {
          params: { projectPath: projectDir, path: "review-0.md" },
        });
        logE2eEvent("review-handoff.still-sending", {
          openReviews,
          button: await button.innerText(),
          disabled: await button.isDisabled(),
          saveStatus: await tab
            .getByTestId("document-save-status")
            .getAttribute("aria-label"),
          watchStatus: await watchStatus.json(),
          consoleErrors,
        });
        throw failure;
      }
      const watchResponse = await pendingWatch;
      const payload = await watchResponse.json();
      expect(payload.events).toHaveLength(1);
      expect(payload.events[0].type).toBe("review.completed");
      expect(consoleErrors).toEqual([]);
    } finally {
      await Promise.all(tabs.map((tab) => tab.close()));
      await pendingWatch?.catch(() => undefined);
      removeMarkdownProject(projectDir);
    }
  });
}

test("allows a manual retry after the save transport misses its deadline", async ({
  page,
  request,
}) => {
  const projectDir = createMarkdownProject("handoff-deadline");
  const filePath = writeProjectFile(projectDir, "deadline.md", "# Ready\n");
  let heldSave: Route | undefined;
  let pendingWatch: ReturnType<typeof request.post> | undefined;
  try {
    pendingWatch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: "deadline.md",
        timeoutSeconds: 20,
      },
    });
    await openMarkdownFile(page, filePath);
    const button = page.getByTestId("review-handoff-button");
    await expect(button).toBeVisible();
    await expect(page.getByTestId("document-save-status")).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    // Hold the actual browser fetch at the transport boundary. Its production
    // AbortSignal deadline, rather than a rejected mock promise, must recover UI.
    await page.route("**/api/markdown-file?**", async (route) => {
      if (route.request().method() === "PUT") {
        heldSave = route;
        return;
      }
      await route.continue();
    });
    await button.click();
    await expect(button).toHaveText("Sending");
    await expect.poll(() => Boolean(heldSave)).toBe(true);
    await expect(page.getByTestId("review-handoff-status")).toContainText(
      "Could not notify agent",
      { timeout: 18_000 },
    );
    await expect(button).toHaveText("Not sent");
    await expect(button).toBeEnabled();
    const response = await pendingWatch;
    expect((await response.json()).events).toEqual([]);
    logE2eEvent("review-handoff.save-deadline", {
      button: await button.innerText(),
      completionEvents: 0,
    });
    // Recovery is explicit: release the failed transport only after confirming
    // that its timed-out attempt never completed the review.
    await heldSave?.abort().catch(() => undefined);
    heldSave = undefined;
    await page.unroute("**/api/markdown-file?**");
    await page.keyboard.press("Escape");
    const completion = page.waitForResponse(
      (result) =>
        result.request().method() === "POST" &&
        new URL(result.url()).pathname === "/api/review-events",
    );
    await button.click();
    const retried = await completion;
    expect(retried.status()).toBe(201);
    expect(await retried.json()).toMatchObject({ delivered: false });
    await expect(button).toHaveText("Not sent, but saved");
    const history = await request.get("/api/reviews/history", {
      params: { documentPath: filePath },
    });
    expect((await history.json()).rounds).toHaveLength(1);
    logE2eEvent("review-handoff.manual-retry-saved", { completedRounds: 1 });
  } finally {
    await heldSave?.abort().catch(() => undefined);
    await page.close();
    await pendingWatch?.catch(() => undefined);
    removeMarkdownProject(projectDir);
  }
});
