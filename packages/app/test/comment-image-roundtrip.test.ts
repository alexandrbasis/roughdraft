import { describe, expect, it } from "vitest";
import { buildCommentThreadRailItems } from "../src/document-comments";
import {
  criticMarkdownToEditorState,
  criticMarkdownToRenderedHtml,
  editorStateToCriticMarkdown,
} from "../src/critic-markup";

// Exercise the same format boundary as saving an edited comment and reopening it.
describe("comment image Markdown round trip", () => {
  it("shows a document-level handoff screenshot without a text anchor", () => {
    const input = [
      "# Reviewed document",
      "",
      "---",
      "comments:",
      "  c2:",
      "    body: |-",
      "      Overall spacing feedback.",
      "",
      "      ![handoff.png](./.roughdraft-assets/handoff.png)",
      "    by: user",
      '    at: "2026-09-09T08:00:00.000Z"',
      "",
    ].join("\n");
    const parsed = criticMarkdownToEditorState(input);
    expect(parsed.comments.get("c2")?.scope).toBe("document");

    const items = buildCommentThreadRailItems([], parsed.comments, {
      includeDocumentComments: true,
    });

    expect(items.map((item) => item.rootCommentId)).toContain("c2");
  });

  for (const withEndmatter of [false, true]) {
    it.each([
      "Screenshot of the spacing:\n\n![image.png](./.roughdraft-assets/image.png)",
      "![image.png](./.roughdraft-assets/image.png)",
    ])(`keeps an anchored screenshot comment after save and reopen (${withEndmatter ? "YAML metadata" : "inline metadata"}): %s`, (body) => {
      const input = withEndmatter
        ? "Check {==this layout==}{>>Please check spacing.<<}{#c1}\n\n---\ncomments:\n  c1:\n    by: user\n"
        : 'Check {==this layout==}{>>Please check spacing.<<}{id="c1" by="user" at="2026-09-09T08:00:00.000Z"}\n';
      const parsed = criticMarkdownToEditorState(input);
      const original = parsed.comments.get("c1");
      if (!original)
        throw new Error("Fixture must contain anchored comment c1");
      parsed.comments.set("c1", { ...original, content: body });

      const saved = editorStateToCriticMarkdown(parsed.doc, parsed.comments);
      const reopened = criticMarkdownToEditorState(saved);

      expect(saved).toContain("{>><<}{#c1}");
      expect(reopened.comments.get("c1")?.content).toBe(body);
      const { html: rendered } = criticMarkdownToRenderedHtml(saved);
      expect(rendered).toContain('data-comment-ids="[&quot;c1&quot;]"');
      expect(rendered).not.toContain("<img");
    });
  }
});
