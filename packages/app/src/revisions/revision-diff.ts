import type { Node, Schema } from "@tiptap/pm/model";
import { criticMarkdownToEditorState } from "../critic-markup";
import type { DocumentRevision, RevisionChange } from "./types";

interface Token {
  key: string;
  text: string;
  format: string;
  from: number;
  to: number;
}
interface Hunk {
  a: number;
  b: number;
  endA: number;
  endB: number;
}

function formatLabel(
  name: string,
  attrs: Record<string, unknown> = {},
): string {
  const labels: Record<string, string> = {
    paragraph: "Paragraph",
    heading: "Heading",
    bulletList: "Bullet list",
    orderedList: "Numbered list",
    listItem: "List item",
    blockquote: "Block quote",
    taskList: "Task list",
    taskItem: "Task",
    codeBlock: "Code block",
    bold: "Bold",
    italic: "Italic",
    strike: "Strikethrough",
    code: "Inline code",
    link: "Link",
    hardBreak: "Line break",
    horizontalRule: "Horizontal rule",
    image: "Image",
  };
  const label = labels[name] ?? name.replace(/([a-z])([A-Z])/g, "$1 $2");
  if (name === "heading") return `${label} ${attrs.level ?? 1}`;
  if (name === "orderedList") return `${label} (starts at ${attrs.start ?? 1})`;
  if (name === "taskItem")
    return `${label} (${attrs.checked ? "checked" : "unchecked"})`;
  if (name === "codeBlock" && attrs.language)
    return `${label} (${attrs.language})`;
  if (name === "image") {
    const properties = [
      ["source", attrs.src],
      ["alt", attrs.alt],
      ["title", attrs.title],
      ["width", attrs.width],
      ["height", attrs.height],
    ]
      .filter(
        ([, value]) => value !== null && value !== undefined && value !== "",
      )
      .map(([key, value]) => `${key}: ${value}`);
    return properties.length ? `${label} (${properties.join("; ")})` : label;
  }
  if (name === "link") return `${label}: ${attrs.href ?? ""}`;
  return label;
}

// Keep UTF-16 offsets (the coordinate system ProseMirror uses), while treating
// Unicode words and emoji as whole tokens. Review marks never affect equality.
function tokenize(doc: Node): Token[] {
  const tokens: Token[] = [];
  const runs: {
    text: string;
    marks: string;
    format: string;
    from: number;
    to: number;
  }[] = [];
  doc.descendants((node, pos) => {
    if (node.isText) {
      const marks = node.marks
        .filter(
          (mark) => !["commentRef", "criticChange"].includes(mark.type.name),
        )
        .map((mark) => mark.toJSON());
      const signature = JSON.stringify(marks);
      const prior = runs[runs.length - 1];
      if (prior && prior.to === pos && prior.marks === signature) {
        prior.text += node.text ?? "";
        prior.to += node.nodeSize;
      } else
        runs.push({
          text: node.text ?? "",
          marks: signature,
          format:
            marks
              .map((mark) => formatLabel(mark.type, mark.attrs))
              .join(", ") || "Plain text",
          from: pos,
          to: pos + node.nodeSize,
        });
    } else if (node.isLeaf) {
      const text =
        node.type.name === "image"
          ? `![${node.attrs.alt ?? ""}](${node.attrs.src ?? ""})`
          : node.type.name === "hardBreak"
            ? "\n"
            : `[${node.type.name}]`;
      tokens.push({
        key: JSON.stringify([node.type.name, node.attrs]),
        text,
        format: formatLabel(node.type.name, node.attrs),
        from: pos,
        to: pos + node.nodeSize,
      });
    } else if (node.isTextblock) {
      const resolved = doc.resolve(pos);
      const ancestors = Array.from({ length: resolved.depth }, (_, i) => {
        const ancestor = resolved.node(i + 1);
        return [ancestor.type.name, ancestor.attrs];
      });
      const ancestorLabels = Array.from({ length: resolved.depth }, (_, i) => {
        const ancestor = resolved.node(i + 1);
        return formatLabel(ancestor.type.name, ancestor.attrs);
      });
      // Structural token gives paragraph boundaries, empty blocks and formatting
      // changes a real anchor, without attributing review-only metadata.
      tokens.push({
        key: JSON.stringify([node.type.name, node.attrs, ancestors]),
        text: "\n",
        format: [
          ...ancestorLabels,
          formatLabel(node.type.name, node.attrs),
        ].join(" › "),
        from: pos + 1,
        to: pos + 1,
      });
    }
  });
  for (const run of runs) {
    for (const match of run.text.matchAll(
      /\p{L}[\p{L}\p{M}\p{N}_]*|\p{N}+|\s+|[^\p{L}\p{N}\s]/gu,
    )) {
      const text = match[0];
      tokens.push({
        key: JSON.stringify([text, run.marks]),
        text,
        format: run.format,
        from: run.from + match.index,
        to: run.from + match.index + text.length,
      });
    }
  }
  return tokens.sort((a, b) => a.from - b.from || a.to - b.to);
}

// Trim unchanged edges first. Small edits get exact LCS; large rewrites use a
// bounded lookahead, keeping allocation and work linear in document length.
function diff(a: Token[], b: Token[]): Hunk[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start].key === b[start].key)
    start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1].key === b[endB - 1].key) {
    endA--;
    endB--;
  }
  if (endA === start && endB === start) return [];
  const matches: [number, number][] = [];
  const n = endA - start;
  const m = endB - start;
  if (n * m <= 250_000) {
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] =
          a[start + i].key === b[start + j].key
            ? 1 + table[(i + 1) * width + j + 1]
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i].key === b[start + j].key) {
        matches.push([start + i++, start + j++]);
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
      else j++;
    }
  } else {
    let i = start;
    let j = start;
    while (i < endA && j < endB) {
      if (a[i].key === b[j].key) {
        matches.push([i++, j++]);
        continue;
      }
      let found = false;
      for (let distance = 1; distance <= 64; distance++) {
        if (i + distance < endA && a[i + distance].key === b[j].key) {
          i += distance;
          found = true;
          break;
        }
        if (j + distance < endB && a[i].key === b[j + distance].key) {
          j += distance;
          found = true;
          break;
        }
      }
      if (!found) {
        i++;
        j++;
      }
    }
  }
  const hunks: Hunk[] = [];
  let i = start;
  let j = start;
  for (const [nextA, nextB] of [...matches, [endA, endB]]) {
    if (nextA > i || nextB > j)
      hunks.push({ a: i, b: j, endA: nextA, endB: nextB });
    i = nextA + 1;
    j = nextB + 1;
  }
  return hunks;
}

function mapAnchor(anchor: number, hunks: Hunk[]): number {
  let delta = 0;
  for (const hunk of hunks) {
    if (anchor < hunk.a) break;
    if (anchor === hunk.endA && hunk.endA > hunk.a) return hunk.endB;
    if (anchor <= hunk.endA) return hunk.b;
    delta += hunk.endB - hunk.b - (hunk.endA - hunk.a);
  }
  return anchor + delta;
}

// The component owns revision objects; WeakMap lets closed histories be collected.
// Identity keys avoid a bounded LRU thrashing during full-history replays.
const parsedRevisionCache = new WeakMap<
  Schema,
  WeakMap<DocumentRevision, { content: string; tokens: Token[] }>
>();

function revisionTokens(revision: DocumentRevision, schema: Schema): Token[] {
  let cache = parsedRevisionCache.get(schema);
  if (!cache) {
    cache = new WeakMap();
    parsedRevisionCache.set(schema, cache);
  }
  const cached = cache.get(revision);
  if (cached?.content === revision.content) return cached.tokens;
  const tokens = tokenize(
    schema.nodeFromJSON(criticMarkdownToEditorState(revision.content).doc),
  );
  cache.set(revision, { content: revision.content, tokens });
  return tokens;
}

export function buildRevisionChanges(
  revisions: readonly DocumentRevision[],
  currentDoc: Node,
  schema: Schema,
): RevisionChange[] {
  if (revisions.length < 2) return [];
  let previous = revisionTokens(revisions[0], schema);
  let owners: (string | null)[] = previous.map(() => null);
  const records = new Map<string, Omit<RevisionChange, "from" | "to">>();
  const deletionAnchors = new Map<string, number>();
  const blockDeletions = new Set<string>();
  const advance = (next: Token[], revision?: DocumentRevision) => {
    const hunks = diff(previous, next);
    for (const [id, anchor] of deletionAnchors)
      deletionAnchors.set(id, mapAnchor(anchor, hunks));
    const nextOwners: (string | null)[] = [];
    let cursor = 0;
    hunks.forEach((hunk, index) => {
      for (let i = cursor; i < hunk.a; i++) nextOwners.push(owners[i]);
      const id = revision ? `${revision.id}:${index}` : null;
      if (revision && id) {
        let before = previous
          .slice(hunk.a, hunk.endA)
          .map((token) => token.text)
          .join("");
        const after = next
          .slice(hunk.b, hunk.endB)
          .map((token) => token.text)
          .join("");
        const removedBlockBoundary = previous
          .slice(hunk.a, hunk.endA)
          .some((token) => token.from === token.to);
        if (hunk.b === hunk.endB && removedBlockBoundary) {
          blockDeletions.add(id);
          // LCS may match the removed paragraph's last punctuation with the
          // previous paragraph's punctuation. Show the removed paragraph whole.
          const first = previous[hunk.a];
          if (
            first?.from !== first?.to &&
            first?.key === previous[hunk.endA]?.key &&
            first?.key === next[hunk.b]?.key &&
            /^[.!?]+$/.test(first.text)
          ) {
            before = before.slice(first.text.length) + first.text;
          }
        }
        records.set(id, {
          id,
          revision: revision.number,
          kind:
            hunk.a === hunk.endA
              ? "addition"
              : hunk.b === hunk.endB
                ? "deletion"
                : "replacement",
          before,
          after,
          ...(before === after
            ? {
                beforeFormat: [
                  ...new Set(
                    previous
                      .slice(hunk.a, hunk.endA)
                      .map((token) => token.format),
                  ),
                ].join("; "),
                afterFormat: [
                  ...new Set(
                    next.slice(hunk.b, hunk.endB).map((token) => token.format),
                  ),
                ].join("; "),
              }
            : {}),
        });
        if (hunk.b === hunk.endB) deletionAnchors.set(id, hunk.b);
      }
      for (let i = hunk.b; i < hunk.endB; i++) nextOwners.push(id);
      cursor = hunk.endA;
    });
    for (let i = cursor; i < owners.length; i++) nextOwners.push(owners[i]);
    previous = next;
    owners = nextOwners;
  };
  for (const revision of revisions.slice(1))
    advance(revisionTokens(revision, schema), revision);
  advance(tokenize(currentDoc)); // Draft text has no persisted revision owner.
  const result: RevisionChange[] = [];
  const partCounts = new Map<string, number>();
  for (let i = 0; i < owners.length; ) {
    const id = owners[i];
    let end = i + 1;
    while (end < owners.length && owners[end] === id) end++;
    if (id) {
      const record = records.get(id);
      if (!record)
        throw new Error("Revision provenance has no matching record");
      const part = partCounts.get(id) ?? 0;
      partCounts.set(id, part + 1);
      result.push({
        ...record,
        id: part ? `${id}:part${part}` : id,
        from: previous[i].from,
        to: previous[end - 1].to,
      });
    }
    i = end;
  }
  for (const [id, anchor] of deletionAnchors) {
    let position =
      previous[anchor]?.from ?? Math.max(0, currentDoc.content.size - 1);
    if (blockDeletions.has(id)) {
      const resolved = currentDoc.resolve(position);
      // A removed block stays at a block boundary even when repeated punctuation
      // makes token matching put its anchor inside the neighboring paragraph.
      // At a following block's start (including first-paragraph deletions), keep
      // the start; otherwise anchor after the surviving preceding block.
      if (resolved.parent.isTextblock && resolved.parentOffset > 0)
        position = resolved.end();
    }
    const record = records.get(id);
    if (record) result.push({ ...record, from: position, to: position });
  }
  return result.sort((a, b) => a.from - b.from || a.revision - b.revision);
}
