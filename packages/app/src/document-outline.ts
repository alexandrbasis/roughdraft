import { marked, type Token, type Tokens } from "marked";
import { criticMarkdownToRenderedHtml } from "./critic-markup";
import { splitYamlDocumentMetadata } from "./markdown";

export interface DocumentOutlineHeading {
  id: string;
  level: number;
  text: string;
  sourceOffset: number;
}

export interface MarkdownCodeEditorNavigation {
  scrollToSourceOffset(offset: number): void;
  getSourceOffsetAtViewportY(y: number): number | null;
}

function normalizeNewlinesWithOffsets(source: string): {
  normalized: string;
  originalOffsets: number[];
} {
  const characters: string[] = [];
  const originalOffsets: number[] = [];
  for (let index = 0; index < source.length; index += 1) {
    originalOffsets.push(index);
    if (source[index] === "\r") {
      characters.push("\n");
      if (source[index + 1] === "\n") index += 1;
    } else {
      characters.push(source[index]);
    }
  }
  originalOffsets.push(source.length);
  return { normalized: characters.join(""), originalOffsets };
}

function visibleHeadingText(token: Tokens.Heading): string {
  // Use the same CriticMarkup renderer as the rich editor. Its heading text
  // includes accepted-looking insertions and visible deletions, but omits
  // comment bodies and inline review metadata.
  const { html } = criticMarkdownToRenderedHtml(token.raw);
  const heading = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector("h1, h2, h3, h4, h5, h6");
  return (heading?.textContent ?? token.text)
    .replaceAll("\u2060", "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract the headings that Markdown renders, keeping source positions for navigation. */
export function getDocumentOutline(markdown: string): DocumentOutlineHeading[] {
  const { frontmatter, body: originalBody } =
    splitYamlDocumentMetadata(markdown);
  const { normalized: body, originalOffsets } =
    normalizeNewlinesWithOffsets(originalBody);
  const bodyOffset = frontmatter?.length ?? 0;
  const headings: DocumentOutlineHeading[] = [];

  // Nested Marked tokens omit quote markers and list indentation. Consume
  // their source lines in token order so text inside a preceding paragraph or
  // fenced block cannot be mistaken for a later heading with the same words.
  const locate = (raw: string, from: number, rangeEnd: number) => {
    let cursor = from;
    let firstLineStart: number | null = null;
    for (const rawLine of raw.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const match = body.indexOf(line, cursor);
      if (match < 0 || match >= rangeEnd) break;
      firstLineStart ??= body.lastIndexOf("\n", match - 1) + 1;
      const lineEnd = body.indexOf("\n", match);
      cursor = lineEnd < 0 ? body.length : lineEnd + 1;
    }
    return { firstLineStart: firstLineStart ?? from, end: cursor };
  };

  const visit = (token: Token, from: number, rangeEnd: number): number => {
    if (token.type === "heading") {
      const heading = token as Tokens.Heading;
      const location = locate(heading.raw, from, rangeEnd);
      const sourceOffset = originalOffsets[location.firstLineStart] ?? 0;
      headings.push({
        id: `heading-${bodyOffset + sourceOffset}`,
        level: heading.depth,
        text: visibleHeadingText(heading),
        sourceOffset: bodyOffset + sourceOffset,
      });
      return location.end;
    }

    if (token.type === "blockquote") {
      let cursor = from;
      for (const child of (token as Tokens.Blockquote).tokens) {
        cursor = visit(child, cursor, rangeEnd);
      }
      return cursor;
    } else if (token.type === "list") {
      let cursor = from;
      for (const item of (token as Tokens.List).items) {
        for (const child of item.tokens) {
          cursor = visit(child, cursor, rangeEnd);
        }
      }
      return cursor;
    }
    return locate(token.raw, from, rangeEnd).end;
  };

  let cursor = 0;
  for (const token of marked.lexer(body)) {
    const start = body.indexOf(token.raw, cursor);
    if (start < 0) continue;
    const end = start + token.raw.length;
    visit(token, start, end);
    cursor = end;
  }

  return headings;
}
