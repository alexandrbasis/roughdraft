import { Editor, getSchema } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import * as criticMarkdown from "../critic-markup";
import { criticMarkdownToEditorState } from "../critic-markup";
import { createEditorExtensions } from "../editor-extensions";
import {
  createRevisionPlugin,
  revisionColorClass,
  updateRevisionDecorations,
} from "./revision-decorations";
import { buildRevisionChanges } from "./revision-diff";
import type { DocumentRevision } from "./types";

const schema = getSchema(createEditorExtensions(""));
const parse = (text: string) =>
  schema.nodeFromJSON(criticMarkdownToEditorState(text).doc);
const history = (...contents: string[]): DocumentRevision[] =>
  contents.map((content, number) => ({
    id: `r${number}`,
    number,
    content,
    version: `v${number}`,
    source: number ? "external" : "baseline",
    createdAt: "2026-09-29T00:00:00Z",
    completedAt: "2026-09-29T00:00:00Z",
    actor: number ? "agent" : "unknown",
  }));
const changes = (...contents: string[]) =>
  buildRevisionChanges(
    history(...contents),
    parse(contents.at(-1) ?? ""),
    schema,
  );

it("uses thirty palette slots before repeating the first at V31", () => {
  const classes = Array.from({ length: 30 }, (_, index) =>
    revisionColorClass(index + 1),
  );
  expect(new Set(classes).size).toBe(30);
  expect(revisionColorClass(31)).toBe(revisionColorClass(1));
});

describe("revision provenance", () => {
  it("attributes additions to actual current document positions", () => {
    const result = changes("Hello world", "Hello brave world");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      revision: 1,
      kind: "addition",
      before: "",
      after: "brave ",
    });
    expect(
      parse("Hello brave world").textBetween(result[0].from, result[0].to),
    ).toBe("brave ");
  });
  it("retains a deletion marker with the removed text", () => {
    expect(changes("Hello brave world", "Hello world")[0]).toMatchObject({
      kind: "deletion",
      before: "brave ",
      after: "",
      from: 7,
      to: 7,
    });
  });
  it("latest replacement wins while untouched older additions survive", () => {
    const result = changes(
      "A cat.",
      "A big cat sleeps.",
      "A small cat sleeps.",
    );
    expect(
      result.some(
        (change) => change.revision === 1 && change.after.includes("sleeps"),
      ),
    ).toBe(true);
    expect(result.find((change) => change.revision === 2)).toMatchObject({
      before: "big",
      after: "small",
      kind: "replacement",
    });
    const doc = parse("A small cat sleeps.");
    expect(
      result
        .filter((change) => change.revision === 1)
        .map((change) => doc.textBetween(change.from, change.to))
        .join(""),
    ).not.toContain("small");
  });
  it("removes fully overwritten earlier attribution", () => {
    const result = changes("The red fox", "The green fox", "The blue fox");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      revision: 2,
      before: "green",
      after: "blue",
    });
  });
  it("splits earlier addition provenance around later replacements", () => {
    const text = "Start one NEW three end";
    const result = changes("Start end", "Start one two three end", text);
    const doc = parse(text);
    expect(
      result
        .filter((change) => change.revision === 1)
        .map((change) => doc.textBetween(change.from, change.to)),
    ).toEqual(["one ", " three "]);
    expect(result.find((change) => change.revision === 2)?.after).toBe("NEW");
  });
  it("maps persisted changes past unsaved insertions without coloring draft words", () => {
    const doc = parse("Draft Hello brave world");
    const result = buildRevisionChanges(
      history("Hello world", "Hello brave world"),
      doc,
      schema,
    );
    expect(result).toHaveLength(1);
    expect(doc.textBetween(result[0].from, result[0].to)).toBe("brave ");
  });
  it("suppresses attribution when draft text replaces the persisted change", () => {
    expect(
      buildRevisionChanges(history("red", "green"), parse("blue"), schema),
    ).toEqual([]);
  });
  it("handles Cyrillic, Unicode and paragraph boundaries", () => {
    const result = changes(
      "Привет мир\n\nДругой абзац",
      "Привет 🌍 мир\n\nДругой абзац",
    );
    expect(result[0].after).toBe("🌍 ");
    expect(
      parse("Привет 🌍 мир\n\nДругой абзац").textBetween(
        result[0].from,
        result[0].to,
      ),
    ).toBe("🌍 ");
  });
  it("ignores CriticMarkup comments, including comments splitting a word", () => {
    expect(changes("Hello world", "Hel{==lo==}{>>Comment<<} world")).toEqual(
      [],
    );
    expect(
      changes(
        "Hello",
        "{==Hello==}{>>note<<}{#c1}\n\n---\ncomments:\n  c1:\n    body: note\n    by: AI\n",
      ),
    ).toEqual([]);
  });
  it("describes heading levels and plain-to-bold formatting without changing visible text", () => {
    expect(changes("Title", "# Title")[0]).toMatchObject({
      beforeFormat: "Paragraph",
      afterFormat: "Heading 1",
    });
    expect(changes("# Title", "## Title")[0]).toMatchObject({
      beforeFormat: "Heading 1",
      afterFormat: "Heading 2",
    });
    expect(changes("plain", "**plain**")[0]).toMatchObject({
      before: "plain",
      after: "plain",
      beforeFormat: "Plain text",
      afterFormat: "Bold",
    });
  });
  it("describes list and quotation structure", () => {
    expect(changes("Item", "- Item")[0]).toMatchObject({
      beforeFormat: "Paragraph",
      afterFormat: "Bullet list › List item › Paragraph",
    });
    expect(changes("Item", "> Item")[0]).toMatchObject({
      beforeFormat: "Paragraph",
      afterFormat: "Block quote › Paragraph",
    });
  });
  it("keeps ordinary word replacements free of formatting summaries", () => {
    const result = changes("red", "blue")[0];
    expect(result).toMatchObject({ before: "red", after: "blue" });
    expect(result).not.toHaveProperty("beforeFormat");
    expect(result).not.toHaveProperty("afterFormat");
  });
  it("describes an image title change when source and alt stay the same", () => {
    expect(
      changes('![cat](cat.png "Old title")', '![cat](cat.png "New title")')[0],
    ).toMatchObject({
      before: "![cat](cat.png)",
      after: "![cat](cat.png)",
      beforeFormat: "Image (source: cat.png; alt: cat; title: Old title)",
      afterFormat: "Image (source: cat.png; alt: cat; title: New title)",
    });
  });
  it("reuses parsed immutable revisions for histories longer than 100 entries", () => {
    const revisions = history(
      ...Array.from({ length: 101 }, (_, i) => `Revision ${i} text`),
    );
    const doc = parse(revisions[100].content);
    const parseSpy = vi.spyOn(criticMarkdown, "criticMarkdownToEditorState");
    try {
      buildRevisionChanges(revisions, doc, schema);
      expect(parseSpy).toHaveBeenCalledTimes(101);
      parseSpy.mockClear();
      buildRevisionChanges(revisions, doc, schema);
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });
  it("surfaces image and formatting changes", () => {
    expect(changes("![cat](cat.png)", "![dog](dog.png)")[0]).toMatchObject({
      kind: "replacement",
      before: "![cat](cat.png)",
      after: "![dog](dog.png)",
    });
    expect(changes("plain", "**plain**")[0]).toMatchObject({
      before: "plain",
      after: "plain",
    });
    expect(changes("Title", "# Title")).toHaveLength(1);
  });
  it("maps old deletion markers through later insertions", () => {
    const result = changes(
      "Hello brave world",
      "Hello world",
      "Draft Hello world",
    );
    expect(result.find((change) => change.revision === 1)).toMatchObject({
      from: 13,
      to: 13,
      kind: "deletion",
    });
  });
  it("keeps deletion anchors after a subsequently replaced preceding block", () => {
    const result = changes(
      "First\n\nRemoved\n\nLast",
      "First\n\nLast",
      "New heading\n\nLast",
    );
    const deletion = result.find((change) => change.revision === 1);
    expect(deletion?.from).toBe(
      parse("New heading\n\nLast").child(0).nodeSize + 1,
    );
  });
  it("bounds work for a large rewrite", () => {
    const old = Array.from({ length: 1500 }, (_, i) => `old${i}`).join(" ");
    const next = Array.from({ length: 1500 }, (_, i) => `new${i}`).join(" ");
    const result = changes(old, next);
    expect(result.some((change) => change.revision === 1)).toBe(true);
  });
});

it("renders colored changes without version labels or document mutations", () => {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createEditorExtensions(""),
    content: criticMarkdownToEditorState("Hello brave world").doc,
  });
  editor.registerPlugin(createRevisionPlugin());
  const before = editor.getJSON();
  const result = changes("Hello world", "Hello brave world");
  updateRevisionDecorations(editor, {
    changes: result,
    selectedRevisions: null,
    activeChangeId: null,
    visible: true,
  });
  expect(editor.getJSON()).toEqual(before);
  expect(
    editor.view.dom.querySelector("[data-testid='revision-change-marker']"),
  ).toBeNull();
  expect(editor.view.dom.textContent).toBe("Hello brave world");
  expect(
    editor.view.dom.querySelector("[data-testid='revision-highlight']")
      ?.textContent,
  ).toBe("brave ");
  updateRevisionDecorations(editor, {
    changes: result,
    selectedRevisions: [2],
    activeChangeId: null,
    visible: true,
  });
  expect(
    editor.view.dom.querySelector("[data-testid='revision-highlight']"),
  ).toBeNull();
  expect(editor.getJSON()).toEqual(before);
  editor.destroy();
});

it("shows deleted text inline as a colored strike-through without editing the document", () => {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createEditorExtensions(""),
    content: criticMarkdownToEditorState("Hello world").doc,
  });
  const onUpdate = vi.fn();
  editor.on("update", onUpdate);
  editor.registerPlugin(createRevisionPlugin());
  const before = editor.getJSON();
  const result = changes("Hello brave world", "Hello world");
  const settings = {
    changes: result,
    selectedRevisions: null,
    activeChangeId: null,
    visible: true,
  };

  updateRevisionDecorations(editor, settings);
  const deletion = editor.view.dom.querySelector<HTMLElement>(
    "[data-testid='revision-deletion']",
  );
  expect(
    editor.view.dom.querySelector("[data-testid='revision-deletion'] del")
      ?.textContent,
  ).toBe("brave ");
  expect(deletion?.classList.contains("revision-color-0")).toBe(true);
  expect(deletion?.dataset.revisionChangeId).toBe(result[0].id);
  deletion?.click();
  expect(deletion?.hasAttribute("role")).toBe(false);
  expect(deletion?.hasAttribute("tabindex")).toBe(false);
  expect(editor.getJSON()).toEqual(before);

  updateRevisionDecorations(editor, { ...settings, selectedRevisions: [2] });
  expect(
    editor.view.dom.querySelector("[data-testid='revision-deletion']"),
  ).toBeNull();
  updateRevisionDecorations(editor, { ...settings, visible: false });
  expect(
    editor.view.dom.querySelector("[data-testid='revision-deletion']"),
  ).toBeNull();
  expect(editor.getJSON()).toEqual(before);
  expect(onUpdate).not.toHaveBeenCalled();
  editor.destroy();
});

it("keeps multiple revision colors without adding labels to the paragraph", () => {
  const text = "A small cat sleeps.";
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createEditorExtensions(""),
    content: criticMarkdownToEditorState(text).doc,
  });
  editor.registerPlugin(createRevisionPlugin());
  const result = changes("A cat.", "A big cat sleeps.", text);
  updateRevisionDecorations(editor, {
    changes: result,
    selectedRevisions: null,
    activeChangeId: null,
    visible: true,
  });
  const markers = editor.view.dom.querySelectorAll(
    "[data-testid='revision-change-marker']",
  );
  expect(markers).toHaveLength(0);
  const colors = new Set(
    [
      ...editor.view.dom.querySelectorAll(
        "[data-testid='revision-highlight'], [data-testid='revision-deletion']",
      ),
    ].map((change) => change.getAttribute("data-revision-number")),
  );
  expect(colors).toEqual(new Set(["1", "2"]));
  expect(editor.getText()).toBe(text);
  editor.destroy();
});

it("does not append a paragraph or emit content updates when decorating a document ending in Mermaid", () => {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createEditorExtensions(""),
    content: criticMarkdownToEditorState(
      "```mermaid\nflowchart LR\n A --> B\n```",
    ).doc,
  });
  const onUpdate = vi.fn();
  editor.on("update", onUpdate);
  editor.registerPlugin(createRevisionPlugin());
  const before = editor.getJSON();
  updateRevisionDecorations(editor, {
    changes: [],
    selectedRevisions: null,
    activeChangeId: null,
    visible: true,
  });
  expect(editor.getJSON()).toEqual(before);
  expect(onUpdate).not.toHaveBeenCalled();
  editor.destroy();
});

it("keeps a removed paragraph at its boundary when another edit shares its punctuation", () => {
  const first = "Old introduction.\n\nUse pastel color.\n\nRemoved paragraph.";
  const second = "New introduction.\n\nUse pastel color.";
  const third = "New introduction.\n\nUse color per revision.\n\nNew section.";
  const doc = parse(third);
  const deletion = changes(first, second, third).find(
    (change) => change.revision === 1 && change.kind === "deletion",
  );
  expect(deletion).toBeDefined();
  const secondBlockEnd = doc.child(0).nodeSize + 1 + doc.child(1).content.size;
  expect(deletion?.before).toBe("\nRemoved paragraph.");
  expect(deletion?.from).toBe(secondBlockEnd);
  expect(deletion?.to).toBe(secondBlockEnd);
});

it("keeps deletion of the first paragraph before the surviving next paragraph", () => {
  const first = "Removed paragraph.\n\nSurviving paragraph.";
  const second = "Surviving paragraph.";
  const third = "Changed surviving paragraph.\n\nNew section.";
  const deletion = changes(first, second, third).find(
    (change) => change.revision === 1 && change.kind === "deletion",
  );
  expect(deletion?.from).toBe(1);
  expect(parse(third).resolve(deletion?.from ?? 0).parentOffset).toBe(0);
});
