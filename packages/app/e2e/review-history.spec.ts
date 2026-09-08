import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test("restores a snapshot only after explicitly confirming the current file @smoke", async ({
  page,
  request,
}) => {
  const directory = createMarkdownProject("history-restore");
  const original = "# Launch review\n\nOriginal proposal.\n";
  const edited = "# Launch review\n\nRevised proposal.\n";
  const external = "# Launch review\n\nNew changes from another editor.\n";
  const documentPath = writeProjectFile(directory, "review.md", original);
  try {
    const registered = await request.post("/api/reviews", {
      data: { documentPath },
    });
    expect(registered.status()).toBe(201);
    const review = await registered.json();
    expect(
      (
        await request.put(
          `/api/markdown-file?${new URLSearchParams({ projectPath: directory, path: "review.md" })}`,
          { data: { content: edited } },
        )
      ).ok(),
    ).toBe(true);
    await page.goto("/");
    const card = page.getByTestId("review-home-card").filter({
      has: page.locator(
        `[data-testid="review-home-item"][href="${review.route}"]`,
      ),
    });
    await card.getByTestId("review-history-toggle").click();
    await expect(page.getByTestId("review-snapshot-view")).toHaveCount(2);
    await page.getByTestId("review-snapshot-view").last().click();
    await expect(page.getByTestId("review-snapshot-content")).toHaveText(
      original,
    );
    expect(readProjectFile(directory, "review.md")).toBe(edited);
    writeProjectFile(directory, "review.md", external);
    await page.getByTestId("review-snapshot-restore").click();
    await expect(page.getByTestId("review-snapshot-error")).toBeVisible();
    expect(readProjectFile(directory, "review.md")).toBe(external);
    await expect(page.getByTestId("review-snapshot-restore")).toBeEnabled();
    const screenshotDirectory = path.join(
      process.cwd(),
      ".context/ui-state-screenshots",
    );
    fs.mkdirSync(screenshotDirectory, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotDirectory, "sqlite-history-conflict.png"),
    });
    await page.getByTestId("review-snapshot-restore").click();
    await expect(page.getByTestId("review-snapshot-status")).toContainText(
      "Snapshot restored.",
    );
    expect(readProjectFile(directory, "review.md")).toBe(original);
    const history = await (
      await request.get(
        `/api/reviews/history?${new URLSearchParams({ documentPath })}`,
      )
    ).json();
    expect(history.snapshots).toHaveLength(3);
    logE2eEvent("review-history.restore-verified", {
      conflictPreservedExternal: true,
      explicitRestoreSucceeded: true,
      retainedSnapshots: history.snapshots.length,
    });
  } finally {
    removeMarkdownProject(directory);
  }
});
