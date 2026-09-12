import { Editor } from "@tiptap/core";
import { expect, it } from "vitest";
import {
  criticMarkdownHasReviewRail,
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "../src/critic-markup";
import { createEditorExtensions } from "../src/editor-extensions";
import { protectRichTextRoundTripMarkdown } from "../src/markdown";

it.each([
  ["an unresolved suggestion reference", "{++example++}{#s1}"],
  ["unrelated attributes", '{++example++}{class="sample"}'],
  ["incomplete suggestion attributes", '{++example++}{id="s1"}'],
  [
    "an invalid suggestion timestamp",
    '{++example++}{id="s1" by="user" at="not-a-date"}',
  ],
])("keeps %s as literal fenced code", (_label, source) => {
  const input = `\`\`\`text\n${source}\n\`\`\`\n`;
  const { doc, comments } = criticMarkdownToEditorState(input);

  expect(doc.content?.[0]?.content).toEqual([{ type: "text", text: source }]);
  expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  expect(criticMarkdownHasReviewRail(input)).toBe(false);
});

it("reloads a saved leading-space insertion as a code suggestion", () => {
  const source = [
    "flowchart LR",
    '  START["Start"] --> DONE["Done now"]',
    "",
    '  DONE --> ARCHIVE["Archive"]',
  ].join("\n");
  const annotatedSource = source.replace(
    " now",
    '{++ now++}{id="s1" by="user" at="2026-09-12T04:49:54.595Z"}',
  );
  const input = `Diagram source.\n\n\`\`\`mermaid\n${annotatedSource}\n\`\`\`\n`;
  const { doc, comments } = criticMarkdownToEditorState(input);
  const codeBlock = doc.content?.find((node) => node.type === "codeBlock");

  expect(codeBlock?.content?.map((node) => node.text ?? "").join("")).toBe(
    source,
  );
  expect(
    codeBlock?.content?.find((node) => node.text === " now")?.marks,
  ).toEqual([
    expect.objectContaining({
      type: "criticChange",
      attrs: expect.objectContaining({ kind: "addition", changeId: "s1" }),
    }),
  ]);
  expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  expect(criticMarkdownHasReviewRail(input)).toBe(true);
});

it("restores endmatter-backed code suggestions without parsing their literal code as Markdown", () => {
  const code = '  return "<tag> & **literal**";';
  const input = [
    "```ts",
    `{++${code}++}{#s1}`,
    "```",
    "",
    "---",
    "suggestions:",
    "  s1:",
    "    by: user",
    '    at: "2026-09-12T04:49:54.595Z"',
    "",
  ].join("\n");
  const { doc, comments } = criticMarkdownToEditorState(input);

  expect(doc.content?.[0]?.content).toEqual([
    {
      type: "text",
      text: code,
      marks: [
        {
          type: "criticChange",
          attrs: {
            kind: "addition",
            changeId: "s1",
            authorType: "user",
            authorId: "user",
            createdAt: "2026-09-12T04:49:54.595Z",
          },
        },
      ],
    },
  ]);
  expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
});

it("preserves literal HTML in fenced code after editing a neighboring paragraph and reloading", () => {
  const code =
    "<details>\n<summary>Example</summary>\n  literal body\n</details>";
  const input = `Before\n\n\`\`\`html\n${code}\n\`\`\`\n`;
  const { doc, comments } = criticMarkdownToEditorState(input);
  const editor = new Editor({
    extensions: createEditorExtensions(),
    content: doc,
  });

  try {
    editor.commands.insertContentAt(1, "Edited ");
    const saved = editorStateToCriticMarkdown(editor.getJSON(), comments);
    const reloaded = criticMarkdownToEditorState(saved);
    const codeBlock = reloaded.doc.content?.find(
      (node) => node.type === "codeBlock",
    );

    expect(saved).toContain("Edited Before");
    expect(codeBlock?.content?.map((node) => node.text ?? "").join("")).toBe(
      code,
    );
  } finally {
    editor.destroy();
  }
});

it("keeps raw HTML after a fence whose closing indentation is smaller", () => {
  const input = [
    "  ```html",
    "<span>literal fenced HTML</span>",
    "```",
    "",
    "<details>",
    "<summary>Outside the fence</summary>",
    "outside body",
    "</details>",
    "",
  ].join("\n");
  const { doc, comments } = criticMarkdownToEditorState(input);
  const saved = editorStateToCriticMarkdown(doc, comments);

  expect(saved).toContain("```html\n<span>literal fenced HTML</span>\n```");
  expect(saved).toContain(
    "<details>\n<summary>Outside the fence</summary>\noutside body\n</details>",
  );
});

it("matches closing fences by quote nesting and allows less indentation", () => {
  const input = [
    ">  ```html",
    "> <span>quoted fenced HTML</span>",
    ">```",
    "",
    "<details>",
    "<summary>Outside the quote</summary>",
    "outside body",
    "</details>",
    "",
  ].join("\n");
  const protectedMarkdown = protectRichTextRoundTripMarkdown(input);

  expect(protectedMarkdown).toContain(
    ">  ```html\n> <span>quoted fenced HTML</span>\n>```\n",
  );
  expect(protectedMarkdown).toContain("data-markdown-raw-block");
});

it("preserves Unicode in metadata, body text, and annotations", () => {
  const input = [
    "---",
    "title: Привет 世界",
    "---",
    "",
    "## Привет 世界 🧪",
    'Сохранить {++новый текст++}{id="s1" by="user" at="2026-09-08T10:00:00.000Z"} и {==注釈==}{>>Проверка<<}{id="c1" by="user" at="2026-09-08T10:01:00.000Z"}.',
    "",
  ].join("\n");
  const { doc, comments, frontmatter } = criticMarkdownToEditorState(input);

  expect(editorStateToCriticMarkdown(doc, comments, { frontmatter })).toBe(
    input,
  );
});

it.each([
  ["larger closing indentation", "```html\n<span>literal</span>\n   ```\n"],
  [
    "end of an unclosed quoted code block",
    "> ```html\n> <span>literal</span>\n",
  ],
])("preserves raw HTML after %s", (_label, code) => {
  const raw =
    "<details>\n<summary>Outside</summary>\n\nOriginal body\n\n</details>";
  const { doc, comments } = criticMarkdownToEditorState(`${code}\n${raw}\n`);
  expect(editorStateToCriticMarkdown(doc, comments)).toContain(raw);
});

it("preserves literal HTML in indented code", () => {
  const raw = "<details>\n<summary>Literal</summary>\n</details>";
  const input = raw
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  const { doc, comments } = criticMarkdownToEditorState(`${input}\n`);
  const saved = editorStateToCriticMarkdown(doc, comments);
  const reloaded = criticMarkdownToEditorState(saved);
  expect(
    reloaded.doc.content
      ?.find((node) => node.type === "codeBlock")
      ?.content?.map((node) => node.text ?? "")
      .join(""),
  ).toBe(raw);
  expect(saved).not.toContain("data-markdown-raw-block");
});
