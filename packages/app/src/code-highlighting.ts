import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { type CodeHighlight, highlightCode } from "./highlight-code";

const highlightKey = new PluginKey("codeHighlighting");
const maxHighlightLength = 50_000;
const maxCachedBlocks = 64;

function codeBlocks(doc: Node) {
  const blocks: Array<{
    source: string;
    language: string;
    position: number;
    key: string;
  }> = [];
  doc.descendants((node, position) => {
    if (node.type.name !== "codeBlock") return;
    const language = String(node.attrs.language ?? "")
      .trim()
      .toLowerCase();
    const source = node.textContent;
    if (
      !language ||
      language === "mermaid" ||
      !source ||
      source.length > maxHighlightLength
    )
      return false;
    blocks.push({ source, language, position, key: `${language}\0${source}` });
    return false;
  });
  return blocks;
}

export function codeHighlightPlugin() {
  const cache = new Map<string, CodeHighlight[]>();
  const pending = new Set<string>();
  let decorationCache = new WeakMap<Node, DecorationSet>();

  function decorations(doc: Node) {
    const cached = decorationCache.get(doc);
    if (cached) return cached;
    const result: Decoration[] = [];
    for (const { key, position } of codeBlocks(doc)) {
      for (const token of cache.get(key) ?? []) {
        result.push(
          Decoration.inline(
            position + 1 + token.from,
            position + 1 + token.to,
            {
              class: "code-highlight",
              "data-testid": "code-highlight",
              style: token.style,
            },
          ),
        );
      }
    }
    const set = DecorationSet.create(doc, result);
    decorationCache.set(doc, set);
    return set;
  }

  return new Plugin({
    key: highlightKey,
    props: { decorations: (state) => decorations(state.doc) },
    view: (view) => {
      let destroyed = false;
      let timer: ReturnType<typeof setTimeout>;
      const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          for (const { source, language, key } of codeBlocks(view.state.doc)) {
            if (cache.has(key) || pending.has(key)) continue;
            pending.add(key);
            void highlightCode(source, language)
              .catch(() => [])
              .then((tokens) => {
                pending.delete(key);
                if (destroyed) return;
                cache.set(key, tokens);
                decorationCache = new WeakMap();
                const currentKeys = new Set(
                  codeBlocks(view.state.doc).map((block) => block.key),
                );
                for (const cachedKey of cache.keys()) {
                  if (cache.size <= maxCachedBlocks) break;
                  // Keep every visible block; the bound limits obsolete edits.
                  if (!currentKeys.has(cachedKey)) cache.delete(cachedKey);
                }
                // Read the current document: a completed old request must never
                // decorate edited text using positions from its previous source.
                if (currentKeys.has(key)) {
                  // A visual redraw must not dispatch a transaction: even a
                  // metadata-only transaction can append a trailing paragraph
                  // through StarterKit and trigger a save of unchanged Markdown.
                  view.updateState(view.state);
                }
              });
          }
        }, 120);
      };
      schedule();
      return {
        update: (nextView, previousState) => {
          if (!nextView.state.doc.eq(previousState.doc)) schedule();
        },
        destroy: () => {
          destroyed = true;
          clearTimeout(timer);
          cache.clear();
        },
      };
    },
  });
}
