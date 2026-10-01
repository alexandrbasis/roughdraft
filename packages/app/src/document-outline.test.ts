import { describe, expect, it } from "vitest";
import { getDocumentOutline } from "./document-outline";

describe("getDocumentOutline", () => {
  it("finds ATX and Setext headings, including nested headings, but not fenced code", () => {
    const markdown = [
      "# First",
      "",
      "```md",
      "## Not a heading",
      "```",
      "",
      "> ## Quoted",
      "",
      "- Item",
      "  ### Listed",
      "",
      "Setext heading",
      "--------------",
      "",
    ].join("\n");

    const outline = getDocumentOutline(markdown);
    expect(outline).toEqual([
      { id: "heading-0", level: 1, text: "First", sourceOffset: 0 },
      {
        id: `heading-${markdown.indexOf("> ## Quoted")}`,
        level: 2,
        text: "Quoted",
        sourceOffset: markdown.indexOf("> ## Quoted"),
      },
      {
        id: `heading-${markdown.indexOf("  ### Listed")}`,
        level: 3,
        text: "Listed",
        sourceOffset: markdown.indexOf("  ### Listed"),
      },
      {
        id: `heading-${markdown.indexOf("Setext heading")}`,
        level: 2,
        text: "Setext heading",
        sourceOffset: markdown.indexOf("Setext heading"),
      },
    ]);
  });

  it("keeps repeated formatted titles distinct and omits comment bodies and review endmatter", () => {
    const markdown = [
      "---",
      "title: '# Metadata heading'",
      "---",
      "",
      "#### **Repeat** [here](link.md)",
      "#### **Repeat** [here](link.md)",
      "## {==Visible==}{>># Hidden comment<<}{#c1} {++added++}",
      "### Title {>># Another hidden comment<<}",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: AI",
      '    at: "2026-10-01T00:00:00.000Z"',
      '    body: "# Hidden endmatter heading"',
      "",
    ].join("\n");

    const headings = getDocumentOutline(markdown);
    expect(headings.map(({ level, text }) => [level, text])).toEqual([
      [4, "Repeat here"],
      [4, "Repeat here"],
      [2, "Visible added"],
      [3, "Title"],
    ]);
    expect(headings[0]?.sourceOffset).toBe(markdown.indexOf("####"));
    expect(headings[1]?.sourceOffset).toBe(
      markdown.indexOf("####", markdown.indexOf("####") + 1),
    );
    expect(new Set(headings.map(({ id }) => id)).size).toBe(4);
  });

  it("maps parser offsets back to the original CRLF document", () => {
    const markdown = "# First\r\n\r\n## Second\r\n";
    expect(getDocumentOutline(markdown)).toEqual([
      { id: "heading-0", level: 1, text: "First", sourceOffset: 0 },
      {
        id: `heading-${markdown.indexOf("## Second")}`,
        level: 2,
        text: "Second",
        sourceOffset: markdown.indexOf("## Second"),
      },
    ]);
  });

  it("navigates to the heading line when its marker and title appear earlier in the same quote", () => {
    const markdown = ["> Paragraph mentions ## Repeat", "> ## Repeat", ""].join(
      "\n",
    );

    expect(getDocumentOutline(markdown)).toEqual([
      {
        id: `heading-${markdown.indexOf("> ## Repeat")}`,
        level: 2,
        text: "Repeat",
        sourceOffset: markdown.indexOf("> ## Repeat"),
      },
    ]);
  });

  it("skips repeated heading text in fenced blocks before nested headings", () => {
    const markdown = [
      "> Paragraph mentions ## Repeat",
      "> ```md",
      "> ## Repeat",
      "> ```",
      "> ## Repeat",
      "",
      "- Item mentions ### Listed",
      "  ```md",
      "  ### Listed",
      "  ```",
      "  ### Listed",
      "",
    ].join("\n");

    expect(getDocumentOutline(markdown)).toEqual([
      {
        id: `heading-${markdown.lastIndexOf("> ## Repeat")}`,
        level: 2,
        text: "Repeat",
        sourceOffset: markdown.lastIndexOf("> ## Repeat"),
      },
      {
        id: `heading-${markdown.lastIndexOf("  ### Listed")}`,
        level: 3,
        text: "Listed",
        sourceOffset: markdown.lastIndexOf("  ### Listed"),
      },
    ]);
  });
});
