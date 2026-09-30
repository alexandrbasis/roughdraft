import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { RevisionChange } from "./types";

export interface RevisionDecorationState {
  changes: readonly RevisionChange[];
  selectedRevision: number | null;
  activeChangeId: string | null;
  visible: boolean;
}
interface PluginState {
  settings: RevisionDecorationState;
  decorations: DecorationSet;
}
export const revisionPluginKey = new PluginKey<PluginState>(
  "revisionDecorations",
);
export const revisionColorClass = (revision: number) =>
  `revision-color-${(((revision - 1) % 6) + 6) % 6}`;

function decorations(
  doc: Node,
  state: RevisionDecorationState,
  onSelect: (id: string) => void,
): DecorationSet {
  if (!state.visible) return DecorationSet.empty;
  const items: Decoration[] = [];
  const blocks = new Map<number, RevisionChange[]>();
  for (const change of state.changes) {
    if (
      state.selectedRevision !== null &&
      change.revision !== state.selectedRevision
    )
      continue;
    const from = Math.max(0, Math.min(change.from, doc.content.size));
    const to = Math.max(from, Math.min(change.to, doc.content.size));
    const resolved = doc.resolve(from);
    let blockStart = from;
    for (let depth = resolved.depth; depth > 0; depth--) {
      if (resolved.node(depth).isTextblock) {
        blockStart = resolved.start(depth);
        break;
      }
    }
    const group = blocks.get(blockStart) ?? [];
    group.push(change);
    blocks.set(blockStart, group);
    const color = revisionColorClass(change.revision);
    const active =
      change.id === state.activeChangeId ? " revision-change-active" : "";
    if (from < to) {
      doc.nodesBetween(from, to, (node, position) => {
        if (!node.isText && !node.isLeaf) return;
        const start = Math.max(position, from);
        const end = Math.min(position + node.nodeSize, to);
        if (start >= end) return;
        const overlap = node.marks.some((mark) =>
          ["commentRef", "criticChange"].includes(mark.type.name),
        );
        items.push(
          Decoration.inline(start, end, {
            class: `revision-highlight ${color}${active}${overlap ? " revision-highlight-review-overlap" : ""}`,
            "data-revision-number": String(change.revision),
            "data-revision-change-id": change.id,
            "data-testid": "revision-highlight",
          }),
        );
      });
    }
    if (change.kind !== "deletion" || !change.before.trim()) continue;
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
          removed.tabIndex = 0;
          removed.setAttribute("role", "button");
          removed.setAttribute(
            "aria-label",
            `Show text deleted in revision ${change.revision}: ${change.before.trim()}`,
          );
          removed.title = `Deleted in R${change.revision} · Show before / after`;
          const text = document.createElement("del");
          text.textContent = change.before;
          removed.append(text);
          const select = (event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            onSelect(change.id);
          };
          removed.addEventListener("click", select);
          removed.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") select(event);
          });
          return removed;
        },
        {
          key: `${change.id}:${state.activeChangeId === change.id}`,
          side: -1,
          stopEvent: () => true,
        },
      ),
    );
  }
  for (const [position, group] of blocks) {
    const representative =
      group.find((change) => change.id === state.activeChangeId) ?? group[0];
    const revisions = [...new Set(group.map((change) => change.revision))];
    const active = group.some((change) => change.id === state.activeChangeId);
    items.push(
      Decoration.widget(
        position,
        () => {
          const anchor = document.createElement("span");
          anchor.className = "revision-gutter-anchor";
          const button = document.createElement("button");
          button.type = "button";
          button.className = `revision-change-marker revision-gutter-marker ${revisionColorClass(representative.revision)}${active ? " revision-change-active" : ""}`;
          button.dataset.testid = "revision-change-marker";
          button.dataset.revisionChangeId = representative.id;
          button.dataset.revisionNumber = String(representative.revision);
          button.textContent = `R${representative.revision}${revisions.length > 1 ? ` +${revisions.length - 1}` : ""}`;
          const label = `Show ${group.length} ${group.length === 1 ? "change" : "changes"} in ${revisions.map((revision) => `R${revision}`).join(", ")}`;
          button.setAttribute("aria-label", label);
          button.title = label;
          button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            onSelect(representative.id);
          });
          anchor.append(button);
          return anchor;
        },
        {
          key: `gutter:${position}:${group.map((change) => change.id).join(",")}:${representative.id}:${active}`,
          side: -2,
          stopEvent: () => true,
        },
      ),
    );
  }
  return DecorationSet.create(doc, items);
}

export function createRevisionPlugin(
  onSelect: (id: string) => void,
): Plugin<PluginState> {
  return new Plugin<PluginState>({
    key: revisionPluginKey,
    state: {
      init: () => ({
        settings: {
          changes: [],
          selectedRevision: null,
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
            decorations: decorations(tr.doc, settings, onSelect),
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
      handleClick(_view, _position, event) {
        const target = event.target instanceof Element ? event.target : null;
        if (
          target?.closest(
            "[data-comment-ids], [data-critic-change], .revision-highlight-review-overlap",
          )
        )
          return false;
        const id = target?.closest<HTMLElement>("[data-revision-change-id]")
          ?.dataset.revisionChangeId;
        if (!id) return false;
        onSelect(id);
        return true;
      },
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
