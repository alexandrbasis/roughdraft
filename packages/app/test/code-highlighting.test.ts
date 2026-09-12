import { Editor } from "@tiptap/core";
import CodeBlock from "@tiptap/extension-code-block";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codeHighlightPlugin } from "../src/code-highlighting";
import { type CodeHighlight, highlightCode } from "../src/highlight-code";

vi.mock("../src/highlight-code", () => ({ highlightCode: vi.fn() }));

const editors: Editor[] = [];
function createEditor(
  content = '<pre><code class="language-ts">const before = 1;</code></pre>',
) {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      CodeBlock.extend({
        addProseMirrorPlugins: () => [codeHighlightPlugin()],
      }),
    ],
    content,
  });
  editors.push(editor);
  return editor;
}

const token: CodeHighlight = {
  from: 0,
  to: 5,
  style: "--shiki-light:#123456;--shiki-dark:#abcdef",
};

describe("editor syntax decorations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(highlightCode).mockReset();
  });
  afterEach(() => {
    for (const editor of editors.splice(0)) editor.destroy();
    vi.useRealTimers();
  });

  it("adds token colors without changing the source or emitting document updates", async () => {
    vi.mocked(highlightCode).mockResolvedValue([token]);
    const editor = createEditor();
    const original = editor.getJSON();
    const onUpdate = vi.fn();
    editor.on("update", onUpdate);

    await vi.advanceTimersByTimeAsync(150);

    expect(
      editor.view.dom.querySelector('[data-testid="code-highlight"]')
        ?.textContent,
    ).toBe("const");
    expect(editor.getJSON()).toEqual(original);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("does not decorate edited source with a stale asynchronous result", async () => {
    let resolveFirst!: (tokens: CodeHighlight[]) => void;
    vi.mocked(highlightCode)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce([{ ...token, from: 0, to: 3 }]);
    const editor = createEditor();
    await vi.advanceTimersByTimeAsync(150);
    editor.commands.setContent(
      '<pre><code class="language-ts">let after = 2;</code></pre>',
    );
    await vi.advanceTimersByTimeAsync(150);
    resolveFirst([token]);
    await Promise.resolve();
    await Promise.resolve();

    expect(
      editor.view.dom.querySelector('[data-testid="code-highlight"]')
        ?.textContent,
    ).toBe("let");
    expect(editor.state.doc.textContent).toBe("let after = 2;");
  });
  it("keeps all current blocks highlighted when the document contains many code examples", async () => {
    vi.mocked(highlightCode).mockResolvedValue([token]);
    const editor = createEditor(
      Array.from(
        { length: 70 },
        (_, index) =>
          `<pre><code class="language-ts">const value${index} = ${index};</code></pre>`,
      ).join(""),
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(
      editor.view.dom.querySelectorAll('[data-testid="code-highlight"]'),
    ).toHaveLength(70);
  });
});
