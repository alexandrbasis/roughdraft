import { expect, test } from "@playwright/test";
import { parse } from "yaml";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

// The browser, real file write, durable history and expiring HTTP watch are
// the contract here; mocking completion would miss saved-but-undelivered work.
for (const watcherAtLoad of [false, true]) {
  test(
    watcherAtLoad
      ? "finishes late feedback after the watching agent expires before submission"
      : "finishes late feedback with no watching agent and preserves it across reload",
    async ({ page, request }, testInfo) => {
      const projectDir = createMarkdownProject("late-review");
      const relativePath = "late-review.md";
      const documentPath = writeProjectFile(
        projectDir,
        relativePath,
        "# Late review\n\nThe agent can read my feedback later.\n",
      );
      const overallComment = "Please clarify the release criteria.";
      const completionPosts: string[] = [];
      let pendingWatch: ReturnType<typeof request.post> | undefined;
      await page.clock.install();
      page.on("request", (outgoing) => {
        if (
          outgoing.method() === "POST" &&
          new URL(outgoing.url()).pathname === "/api/review-events"
        ) {
          completionPosts.push(outgoing.url());
        }
      });

      const watchStatus = async () => {
        const response = await request.get("/api/review-events/status", {
          params: { projectPath: projectDir, path: relativePath },
        });
        expect(response.ok()).toBe(true);
        return response.json();
      };
      const history = async () => {
        const response = await request.get("/api/reviews/history", {
          params: { documentPath },
        });
        expect(response.ok()).toBe(true);
        return response.json();
      };

      try {
        // Register the durable review just as opening it from the CLI does,
        // without creating a waiting agent session.
        const registered = await request.post("/api/reviews", {
          data: { documentPath },
        });
        expect(registered.status()).toBe(201);
        expect((await watchStatus()).watcherCount).toBe(0);

        if (watcherAtLoad) {
          // Start the real one-second watch at the first UI status request,
          // so bundling/page startup cannot consume its lifetime beforehand.
          // Concurrent initial polls must wait for the same registration.
          let watcherReady: Promise<void> | undefined;
          await page.route("**/api/review-events/status?**", async (route) => {
            if (!pendingWatch) {
              pendingWatch = request.post("/api/review-events/watch", {
                data: {
                  projectPath: projectDir,
                  path: relativePath,
                  timeoutSeconds: 1,
                },
              });
              watcherReady = expect
                .poll(async () => (await watchStatus()).watcherCount)
                .toBe(1);
            }
            await watcherReady;
            await route.continue();
          });
        }

        const initialStatus = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/review-events/status",
        );
        await openMarkdownFile(page, documentPath);
        expect((await (await initialStatus).json()).watcherCount).toBe(
          watcherAtLoad ? 1 : 0,
        );
        // Page navigation alone does not guarantee the editor has loaded.
        await expect(page.getByTestId("document-save-status")).toHaveAttribute(
          "aria-label",
          "Saved",
        );
        const button = page.getByTestId("review-handoff-button");
        logE2eEvent("late-review.ready", {
          watcherAtLoad,
          buttonVisible: await button.isVisible(),
        });
        await expect(button).toBeVisible();
        await expect(button).toBeEnabled();
        await page.getByTestId("review-handoff-comment-trigger").click();
        await page
          .getByTestId("review-handoff-overall-comment")
          .fill(overallComment);

        if (watcherAtLoad) {
          if (!pendingWatch) throw new Error("The real watch was not started");
          const expired = await pendingWatch;
          expect(expired.ok()).toBe(true);
          expect(await expired.json()).toMatchObject({
            events: [],
            timedOut: true,
          });
        }
        await expect
          .poll(async () => (await watchStatus()).watcherCount)
          .toBe(0);

        const completionResponse = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname === "/api/review-events",
        );
        await page.getByTestId("review-handoff-submit-comment").click();
        const completed = await completionResponse;
        expect(completed.status()).toBe(201);
        const result = await completed.json();
        expect(result).toMatchObject({
          delivered: false,
          event: {
            type: "review.completed",
            overallComment,
            summary: { comments: 1 },
          },
        });

        const savedMarkdown = readProjectFile(projectDir, relativePath);
        const endmatter = savedMarkdown.split("\n---\n");
        expect(endmatter).toHaveLength(2);
        const comments = Object.values(parse(endmatter[1]).comments);
        expect(comments).toEqual([
          { body: overallComment, by: "user", at: expect.any(String) },
        ]);
        const savedHistory = await history();
        expect(savedHistory.rounds).toHaveLength(1);
        expect(savedHistory.rounds[0]).toMatchObject({
          status: "completed",
          eventSequence: result.event.sequence,
        });
        expect(savedHistory.writes).toEqual([]);
        logE2eEvent("late-review.persisted", {
          watcherAtLoad,
          delivered: result.delivered,
          comments: comments.length,
          eventSequence: result.event.sequence,
          completedRounds: savedHistory.rounds.length,
          button: await button.innerText(),
        });

        await expect(button).toHaveText("Not sent, but saved");
        await expect(button).toBeEnabled();
        const status = page.getByTestId("review-handoff-status");
        await expect(status).toBeVisible();
        await expect(status).toContainText("Not sent, but saved");
        await expect(page.getByRole("alert")).toHaveCount(0); // selector-check-ignore: absence of any accessible alert is the contract.
        // A warning icon also communicates failure without an ARIA alert.
        await expect(button.locator(".lucide-triangle-alert")).toHaveCount(0); // selector-check-ignore: negative check for the existing warning icon.
        await expect(status.locator(".lucide-triangle-alert")).toHaveCount(0); // selector-check-ignore: negative check for the existing warning icon.
        await expect(
          page.getByRole("button", { name: /retry|try again/i }), // selector-check-ignore: reject any user-facing retry action regardless of test ID.
        ).toHaveCount(0);
        await expect(status).not.toContainText("Could not notify agent");
        await expect(
          status.getByTestId("review-handoff-robots-toy"),
        ).toHaveCount(0);

        if (!watcherAtLoad) {
          await page.clock.runFor(1_000);
          await expect(page.getByTestId("rich-text-editor")).toBeVisible();
          await expect(page.getByTestId("rich-text-editor")).toContainText(
            "The agent can read my feedback later.",
          );
          await page.screenshot({
            path: testInfo.outputPath("late-review-desktop.png"),
            animations: "disabled",
          });
          const desktopViewport = page.viewportSize();
          await page.setViewportSize({ width: 390, height: 844 });
          await page.clock.runFor(1_000);
          await expect(page.getByTestId("rich-text-editor")).toBeVisible();
          await expect(page.getByTestId("rich-text-editor")).toContainText(
            "The agent can read my feedback later.",
          );
          await expect(button).toBeVisible();
          await expect(status).toBeVisible();
          await page.screenshot({
            path: testInfo.outputPath("late-review-mobile.png"),
            animations: "disabled",
          });
          // On a narrow screen the status panel covers this short document.
          // Capture it dismissed too, so the underlying text is reviewable.
          await page.keyboard.press("Escape");
          await expect(status).toBeHidden();
          await page.screenshot({
            path: testInfo.outputPath("late-review-mobile-document.png"),
            animations: "disabled",
          });
          await button.click();
          await expect(status).toBeVisible();
          if (desktopViewport) await page.setViewportSize(desktopViewport);
        }

        await page.keyboard.press("Escape");
        await expect(status).toBeHidden();
        await button.click();
        await expect(status).toBeVisible();
        await expect(status).toContainText("Not sent, but saved");

        // Cross a minute of browser timers, then allow pending HTTP work to
        // settle. This bounds retry observation without a wall-clock minute.
        await page.clock.fastForward(60_000);
        await page.clock.runFor(1_000);
        expect(completionPosts).toHaveLength(1);
        expect(readProjectFile(projectDir, relativePath)).toBe(savedMarkdown);

        await page.reload();
        await expect(page.getByTestId("document-save-status")).toHaveAttribute(
          "aria-label",
          "Saved",
        );
        await page.clock.fastForward(60_000);
        await page.clock.runFor(1_000);
        expect(readProjectFile(projectDir, relativePath)).toBe(savedMarkdown);
        expect(await history()).toEqual(savedHistory);
        expect(completionPosts).toHaveLength(1);
        logE2eEvent("late-review.reload-verified", {
          watcherAtLoad,
          completionPosts: completionPosts.length,
          browserMinutesWithoutRetry: 2,
        });
      } finally {
        await page.close();
        await pendingWatch?.catch(() => undefined);
        removeMarkdownProject(projectDir);
      }
    },
  );
}
