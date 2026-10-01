import { expect, test } from "@playwright/test";
import {
  appendInCodeEditor,
  createMarkdownProject,
  documentSaveStatus,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test("autosave ring progresses through the existing window and Saved waits for the write @smoke", async ({
  page,
}) => {
  const projectDir = createMarkdownProject("autosave-indicator");
  const original = "# Autosave indicator\n\nOriginal body.\n";
  const documentPath = writeProjectFile(projectDir, "review.md", original);
  let putStarted!: () => void;
  const putRequest = new Promise<void>((resolve) => {
    putStarted = resolve;
  });
  let releasePut!: () => void;
  const release = new Promise<void>((resolve) => {
    releasePut = resolve;
  });
  let held = false;

  await page.route("**/api/markdown-file?**", async (route) => {
    if (route.request().method() !== "PUT" || held) {
      await route.continue();
      return;
    }
    held = true;
    putStarted();
    await release;
    await route.continue();
  });

  try {
    await openMarkdownFile(page, documentPath, "code");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    const editStartedAt = Date.now();
    await appendInCodeEditor(page, "\nFirst sentence.\n");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Unsaved changes",
    );
    const countdown = page.getByRole("progressbar"); // selector-check-ignore: the accessible countdown is the user-facing contract being tested.
    await expect(countdown).toBeVisible({ timeout: 2_000 });
    await expect(countdown).toHaveAttribute("aria-label", "Autosave countdown");
    await expect(countdown).toHaveAttribute("aria-valuemin", "0");
    await expect(countdown).toHaveAttribute("aria-valuemax", "100");
    const ring = countdown.locator('[data-slot="progress-ring-indicator"]'); // selector-check-ignore: the visible SVG stroke is the behavior under test.
    await expect(ring).toBeVisible();
    const strokeOffset = () =>
      ring.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).strokeDashoffset),
      );

    await page.waitForTimeout(2_000);
    const early = Number(await countdown.getAttribute("aria-valuenow"));
    const earlyStrokeOffset = await strokeOffset();
    expect(early).toBeGreaterThan(5);
    expect(early).toBeLessThan(65);
    expect(Number.isFinite(earlyStrokeOffset)).toBe(true);
    await page.waitForTimeout(2_000);
    const beforeSecondEdit = Number(
      await countdown.getAttribute("aria-valuenow"),
    );
    const laterStrokeOffset = await strokeOffset();
    expect(beforeSecondEdit).toBeGreaterThan(early + 10);
    expect(beforeSecondEdit).toBeLessThan(85);
    expect(laterStrokeOffset).toBeLessThan(earlyStrokeOffset - 10);

    await appendInCodeEditor(page, "\nSecond sentence.\n");
    const secondEditAt = Date.now();
    const afterSecondEdit = Number(
      await countdown.getAttribute("aria-valuenow"),
    );
    const afterSecondStrokeOffset = await strokeOffset();
    expect(afterSecondEdit).toBeGreaterThanOrEqual(beforeSecondEdit - 5);
    expect(afterSecondStrokeOffset).toBeLessThanOrEqual(laterStrokeOffset + 5);
    expect(readProjectFile(projectDir, "review.md")).toBe(original);
    logE2eEvent("autosave-indicator.progress", {
      early,
      beforeSecondEdit,
      afterSecondEdit,
      earlyStrokeOffset,
      laterStrokeOffset,
      afterSecondStrokeOffset,
    });

    await Promise.race([
      putRequest,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "Autosave did not start within the original 10-second window",
              ),
            ),
          7_500,
        ),
      ),
    ]);
    expect(Date.now() - secondEditAt).toBeLessThan(7_500);
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saving",
    );
    expect(readProjectFile(projectDir, "review.md")).toBe(original);
    await expect(documentSaveStatus(page)).not.toHaveAttribute(
      "aria-label",
      "Saved",
    );
    logE2eEvent("autosave-indicator.put-held", {
      elapsedFromFirstEditMs: Date.now() - editStartedAt,
      elapsedFromSecondEditMs: Date.now() - secondEditAt,
      diskUnchanged: readProjectFile(projectDir, "review.md") === original,
    });

    releasePut();
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    await expect
      .poll(() => readProjectFile(projectDir, "review.md"))
      .toContain("Second sentence.");
    logE2eEvent("autosave-indicator.saved-after-write", {
      diskHasBothEdits: readProjectFile(projectDir, "review.md").includes(
        "First sentence.\n\nSecond sentence.",
      ),
    });
  } finally {
    releasePut();
    removeMarkdownProject(projectDir);
  }
});
