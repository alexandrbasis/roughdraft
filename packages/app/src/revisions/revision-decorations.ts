import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { RevisionChange } from "./types";

export interface RevisionDecorationState {
  changes: readonly RevisionChange[];
  selectedRevisions: readonly number[] | null;
  activeChangeId: string | null;
  visible: boolean;
  /** History previews show the full transition, including replacement before-text. */
  completeComparison?: boolean;
}
interface PluginState {
  settings: RevisionDecorationState;
  decorations: DecorationSet;
}
export const revisionPluginKey = new PluginKey<PluginState>(
  "revisionDecorations",
);
export const revisionColorClass = (revision: number) =>
  `revision-color-${(((revision - 1) % 30) + 30) % 30}`;

function decorations(doc: Node, state: RevisionDecorationState): DecorationSet {
  if (!state.visible) return DecorationSet.empty;
  const items: Decoration[] = [];
  for (const change of state.changes) {
    if (
      state.selectedRevisions !== null &&
      !state.selectedRevisions.includes(change.revision)
    )
      continue;
    const from = Math.max(0, Math.min(change.from, doc.content.size));
    const to = Math.max(from, Math.min(change.to, doc.content.size));
    const color = revisionColorClass(change.revision);
    const active =
      change.id === state.activeChangeId ? " revision-change-active" : "";
    const formatDescription =
      change.beforeFormat && change.afterFormat
        ? `${change.beforeFormat} → ${change.afterFormat}`
        : undefined;
    const attributes = {
      class: `revision-highlight ${color}${active}`,
      "data-revision-number": String(change.revision),
      "data-revision-change-id": change.id,
      "data-testid": "revision-highlight",
      ...(formatDescription ? { title: formatDescription } : {}),
    };
    if (state.completeComparison && from === to && change.kind !== "deletion") {
      const resolved = doc.resolve(from);
      if (resolved.parent.isTextblock && resolved.depth > 0) {
        items.push(
          Decoration.node(resolved.before(), resolved.after(), attributes),
        );
      }
    }
    if (from < to) {
      doc.nodesBetween(from, to, (node, position) => {
        if (!node.isText && !node.isLeaf) return;
        const start = Math.max(position, from);
        const end = Math.min(position + node.nodeSize, to);
        if (start >= end) return;
        const overlap = node.marks.some((mark) =>
          ["commentRef", "criticChange"].includes(mark.type.name),
        );
        if (state.completeComparison && node.isBlock && node.isLeaf) {
          items.push(
            Decoration.node(position, position + node.nodeSize, attributes),
          );
          return;
        }
        items.push(
          Decoration.inline(start, end, {
            ...attributes,
            class: `${attributes.class}${overlap ? " revision-highlight-review-overlap" : ""}`,
          }),
        );
      });
    }
    const showRemoved =
      change.kind === "deletion" ||
      (state.completeComparison &&
        change.kind === "replacement" &&
        change.before !== change.after);
    const structureOnly =
      state.completeComparison &&
      from === to &&
      (!change.before.trim() || change.before === change.after);
    if (structureOnly) {
      items.push(
        Decoration.widget(
          from,
          () => {
            const label = document.createElement("span");
            label.className = `revision-structure-label ${color}`;
            label.dataset.testid = "revision-structure-change";
            label.dataset.revisionNumber = String(change.revision);
            label.contentEditable = "false";
            label.textContent =
              formatDescription ??
              (showRemoved ? "Removed block" : "Added block");
            return label;
          },
          { key: `${change.id}:structure`, side: -1 },
        ),
      );
    }
    if (!showRemoved || !change.before.trim()) continue;
    items.push(
      Decoration.widget(
        from,
        () => {
          // A wrapping text decoration, kept outside the editable document.
          const removed = document.createElement("span");
          removed.className = `revision-deletion ${color}${active}`;
          removed.dataset.testid = "revision-deletion";
          removed.dataset.revisionChangeId = change.id;
          removed.dataset.revisionNumber = String(change.revision);
          removed.contentEditable = "false";
          removed.title = `Removed in V${change.revision}`;
          const text = document.createElement("del");
          text.textContent = change.before;
          removed.append(text);
          return removed;
        },
        {
          key: `${change.id}:${state.activeChangeId === change.id}`,
          side: -1,
        },
      ),
    );
  }
  return DecorationSet.create(doc, items);
}

export function createRevisionPlugin(): Plugin<PluginState> {
  return new Plugin<PluginState>({
    key: revisionPluginKey,
    state: {
      init: () => ({
        settings: {
          changes: [],
          selectedRevisions: null,
          activeChangeId: null,
          visible: false,
        },
        decorations: DecorationSet.empty,
      }),
      apply(tr, previous) {
        const settings = tr.getMeta(revisionPluginKey) as
          | RevisionDecorationState
          | undefined;
        if (settings)
          return {
            settings,
            decorations: decorations(tr.doc, settings),
          };
        return {
          settings: previous.settings,
          decorations: previous.decorations.map(tr.mapping, tr.doc),
        };
      },
    },
    props: {
      decorations: (state) =>
        revisionPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
    },
  });
}

export function updateRevisionDecorations(
  editor: Editor,
  state: RevisionDecorationState,
): void {
  editor.view.dispatch(
    editor.state.tr
      .setMeta(revisionPluginKey, state)
      .setMeta("addToHistory", false)
      // StarterKit otherwise appends a paragraph after a terminal code block,
      // even for this metadata-only transaction, triggering an unwanted save.
      .setMeta("skipTrailingNode", true),
  );
}
