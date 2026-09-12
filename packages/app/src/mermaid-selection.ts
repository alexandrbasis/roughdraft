import { type Editor, Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { mermaidSourceSelectionEvent } from "./CodeBlockView";

function revealAtPosition(view: EditorView, position: number) {
  const $position = view.state.doc.resolve(position);
  if (
    $position.parent.type.name !== "codeBlock" ||
    String($position.parent.attrs.language).trim().toLowerCase() !== "mermaid"
  ) {
    return;
  }

  const element = view.nodeDOM($position.before());
  if (element instanceof HTMLElement) {
    element.dispatchEvent(
      new CustomEvent(mermaidSourceSelectionEvent, { bubbles: true }),
    );
  }
}

/** Reveal a review anchor before PageCard measures or scrolls to it. */
export function revealMermaidSourceForPosition(
  editor: Editor,
  position: number,
) {
  revealAtPosition(editor.view, position);
}

export const MermaidSelectionReveal = Extension.create({
  name: "mermaidSelectionReveal",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("mermaidSelectionReveal"),
        view: () => ({
          update: (view, previousState) => {
            if (view.state.selection.eq(previousState.selection)) return;
            const { from, to } = view.state.selection;
            revealAtPosition(view, from);
            if (from === to) return;
            view.state.doc.nodesBetween(from, to, (node, position) => {
              if (node.type.name === "codeBlock") {
                revealAtPosition(view, position + 1);
                return false;
              }
            });
          },
        }),
      }),
    ];
  },
});
