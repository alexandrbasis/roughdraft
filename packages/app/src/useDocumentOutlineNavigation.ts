import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DocumentOutlineHeading,
  MarkdownCodeEditorNavigation,
} from "./document-outline";

function richTextHeadings(editor: Editor | null) {
  const elements: HTMLElement[] = [];
  if (!editor || editor.isDestroyed) return elements;
  editor.state.doc.descendants((node, position) => {
    if (node.type.name !== "heading") return;
    const element = editor.view.nodeDOM(position);
    if (element instanceof HTMLElement) elements.push(element);
  });
  return elements;
}

export function useDocumentOutlineNavigation({
  headings,
  editor,
  sourceNavigation,
  sourceMode,
  workspace,
}: {
  headings: DocumentOutlineHeading[];
  editor: Editor | null;
  sourceNavigation: MarkdownCodeEditorNavigation | null;
  sourceMode: boolean;
  workspace: HTMLElement | null;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const navigationTarget = useRef<{
    id: string;
    position: { scrollTop: number; sourceOffset: number | null } | null;
  } | null>(null);
  const navigationFrame = useRef<number | null>(null);

  useEffect(() => {
    if (!workspace) return;
    navigationTarget.current = null;
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const top = workspace.getBoundingClientRect().top + 32;
      const sourceOffset = sourceMode
        ? (sourceNavigation?.getSourceOffsetAtViewportY(top) ?? null)
        : null;
      const target = navigationTarget.current;
      // A destination near the end cannot always reach the top of the pane.
      // Keep the chosen section active until the reading position changes.
      if (
        target &&
        (!target.position ||
          (target.position.scrollTop === workspace.scrollTop &&
            target.position.sourceOffset === sourceOffset))
      ) {
        setActiveId(target.id);
        return;
      }
      navigationTarget.current = null;
      let active = headings[0]?.id ?? null;
      if (sourceMode) {
        if (sourceOffset != null) {
          for (const heading of headings) {
            if (heading.sourceOffset > sourceOffset) break;
            active = heading.id;
          }
        }
      } else {
        const elements = richTextHeadings(editor);
        for (let index = 0; index < elements.length; index += 1) {
          if (elements[index].getBoundingClientRect().top > top) break;
          active = headings[index]?.id ?? active;
        }
      }
      setActiveId(active);
    };
    const schedule = () => {
      if (frame == null) frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(workspace);
    if (!sourceMode && editor && !editor.isDestroyed) {
      resize.observe(editor.view.dom);
    }
    workspace.addEventListener("scroll", schedule, {
      passive: true,
      capture: true,
    });
    window.addEventListener("resize", schedule);
    editor?.on("update", schedule);
    schedule();
    return () => {
      if (frame != null) cancelAnimationFrame(frame);
      if (navigationFrame.current != null) {
        cancelAnimationFrame(navigationFrame.current);
      }
      resize.disconnect();
      workspace.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      editor?.off("update", schedule);
    };
  }, [headings, editor, sourceNavigation, sourceMode, workspace]);

  const navigate = useCallback(
    (heading: DocumentOutlineHeading) => {
      if (!workspace) return;
      if (sourceMode) {
        sourceNavigation?.scrollToSourceOffset(heading.sourceOffset);
      } else {
        const index = headings.findIndex((item) => item.id === heading.id);
        const element = richTextHeadings(editor)[index];
        if (!element) return;
        workspace.scrollTo({
          top:
            workspace.scrollTop +
            element.getBoundingClientRect().top -
            workspace.getBoundingClientRect().top -
            24,
          behavior: "instant",
        });
      }
      const target: NonNullable<typeof navigationTarget.current> = {
        id: heading.id,
        position: null,
      };
      navigationTarget.current = target;
      if (navigationFrame.current != null) {
        cancelAnimationFrame(navigationFrame.current);
      }
      // CodeMirror applies its scroll effect during its next layout pass.
      navigationFrame.current = requestAnimationFrame(() => {
        navigationFrame.current = null;
        target.position = {
          scrollTop: workspace.scrollTop,
          sourceOffset: sourceMode
            ? (sourceNavigation?.getSourceOffsetAtViewportY(
                workspace.getBoundingClientRect().top + 32,
              ) ?? null)
            : null,
        };
      });
      setActiveId(heading.id);
    },
    [headings, editor, sourceNavigation, sourceMode, workspace],
  );

  return { activeId, navigate };
}
