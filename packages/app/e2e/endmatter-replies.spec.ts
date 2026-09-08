import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test.describe("YAML endmatter replies", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("endmatter-replies");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  for (const embedded of [false, true]) {
    test(`keeps a YAML-only reply after save and reload (${embedded ? "embedded" : "standard"}) @smoke`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      const filePath = writeProjectFile(
        projectDir,
        "endmatter-reply.md",
        [
          "# Endmatter Reply",
          "",
          "This paragraph has {==target text==}{>>Needs detail<<}{#c1}.",
          "",
          "---",
          "comments:",
          "  c1:",
          "    by: user",
          '    at: "2026-04-23T18:00:00.000Z"',
          "",
        ].join("\n"),
      );
      const reply = "YAML-only reply survives reload.";

      await openMarkdownFile(page, filePath);
      if (embedded) {
        const url = new URL(page.url());
        url.searchParams.set("embed", "1");
        await page.goto(url.toString());
      }
      const rail = page.getByTestId("document-review-rail");
      await expect(rail).toContainText("Needs detail");

      await page.getByTestId("comment-thread-c1").click();
      await page.getByTestId("comment-rail-c1-action-reply").click();
      await page.getByTestId("comment-rail-c2-editor").fill(reply);
      await page.getByTestId("comment-rail-c2-action-save").click();

      await expect
        .poll(() => readProjectFile(projectDir, "endmatter-reply.md"))
        .toContain(`body: ${reply}`);
      const saved = readProjectFile(projectDir, "endmatter-reply.md");
      expect(saved).toContain("re: c1");
      expect(saved).not.toContain(`{>>${reply}<<}`);

      await page.reload();
      await expect(rail).toContainText(reply);
      await expect(page.getByTestId("comment-rail-c2")).toHaveCount(1);

      logE2eEvent("endmatter-replies.reload-preserved", {
        file: "endmatter-reply.md",
        reply,
      });
    });
  }
});
