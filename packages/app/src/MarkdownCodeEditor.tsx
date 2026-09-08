import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { cn } from "./lib/utils";

// CSS variables follow appearance changes without recreating the editor or
// touching its document, selection, or undo history.
const markdownHighlightStyle = HighlightStyle.define([
  {
    tag: [tags.meta, tags.comment, tags.processingInstruction],
    color: "var(--syntax-muted)",
  },
  {
    tag: [tags.link, tags.url],
    color: "var(--syntax-link)",
    textDecoration: "underline",
  },
  { tag: tags.heading, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.keyword, color: "var(--syntax-keyword)" },
  {
    tag: [
      tags.atom,
      tags.bool,
      tags.number,
      tags.contentSeparator,
      tags.labelName,
    ],
    color: "var(--syntax-keyword)",
  },
  {
    tag: [tags.literal, tags.string, tags.regexp, tags.inserted],
    color: "var(--syntax-literal)",
  },
  { tag: [tags.invalid, tags.deleted], color: "var(--syntax-invalid)" },
]);

interface MarkdownCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  readOnly?: boolean;
  className?: string;
  testId?: string;
}

export function createMarkdownCodeEditorExtensions(
  readOnly: boolean,
  onDocumentChange: (value: string) => void,
  lastValueRef: { current: string },
): Extension[] {
  return [
    basicSetup,
    yamlFrontmatter({ content: markdown() }),
    syntaxHighlighting(markdownHighlightStyle),
    EditorView.lineWrapping,
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;

      const nextValue = update.state.doc.toString();
      if (nextValue === lastValueRef.current) return;

      lastValueRef.current = nextValue;
      onDocumentChange(nextValue);
    }),
    EditorView.theme({
      "&": {
        backgroundColor: "transparent",
        color: "inherit",
        fontFamily:
          'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: "0.95rem",
      },
      ".cm-scroller": {
        fontFamily: "inherit",
        lineHeight: "1.75",
        overflow: "auto",
      },
      ".cm-content": {
        minHeight: "70vh",
        padding: "0",
      },
      ".cm-line": {
        padding: "0",
      },
      ".cm-gutters": {
        backgroundColor: "transparent",
        border: "none",
        color: "rgb(148 163 184)",
        marginRight: "0.75rem",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: "var(--cm-selection-bg, rgb(224 242 254))",
      },
      ".cm-gutterElement": {
        padding: "0 0.5rem 0 0",
      },
      ".cm-foldGutter": {
        display: "none",
      },
      ".cm-activeLine": {
        backgroundColor: "transparent",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
        color: "rgb(100 116 139)",
      },
      "&.cm-focused": {
        outline: "none",
      },
    }),
  ];
}

export function MarkdownCodeEditor({
  value,
  onChange,
  autoFocus = false,
  readOnly = false,
  className,
  testId,
}: MarkdownCodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const initialValueRef = useRef(value);
  const lastValueRef = useRef(value);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const hostElement = hostRef.current;
    if (!hostElement) return;

    const view = new EditorView({
      parent: hostElement,
      state: EditorState.create({
        doc: initialValueRef.current,
        extensions: createMarkdownCodeEditorExtensions(
          readOnly,
          (nextValue) => onChangeRef.current(nextValue),
          lastValueRef,
        ),
      }),
    });

    editorViewRef.current = view;
    lastValueRef.current = view.state.doc.toString();

    if (autoFocus) {
      view.focus();
    }

    return () => {
      editorViewRef.current = null;
      view.destroy();
    };
  }, [autoFocus, readOnly]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;

    const currentValue = view.state.doc.toString();
    if (currentValue === value) {
      lastValueRef.current = value;
      return;
    }

    lastValueRef.current = value;
    view.dispatch({
      changes: {
        from: 0,
        to: currentValue.length,
        insert: value,
      },
    });
  }, [value]);

  return (
    <div
      ref={hostRef}
      className={cn("markdown-code-editor", className)}
      data-testid={testId}
    />
  );
}
