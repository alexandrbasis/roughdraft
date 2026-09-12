import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { getDockClearanceScrollDelta } from "./comment-dock";
import { parseCommentIds } from "./document-comments";

export function useCommentDock(
  visible: boolean,
  commentId: string | null,
  embeddedContainerRef?: RefObject<HTMLDivElement | null>,
) {
  const dockRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const dock =
      embeddedContainerRef?.current?.querySelector<HTMLElement>(
        ".document-comment-rail--docked",
      ) ?? dockRef.current;
    if (!dock || !visible) {
      setHeight(0);
      return;
    }
    const measure = () => {
      setHeight(
        getComputedStyle(dock).position === "fixed"
          ? Math.ceil(window.innerHeight - dock.getBoundingClientRect().top)
          : 0,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [visible, embeddedContainerRef]);

  useLayoutEffect(() => {
    const dock =
      embeddedContainerRef?.current?.querySelector<HTMLElement>(
        ".document-comment-rail--docked",
      ) ?? dockRef.current;
    if (!dock || height === 0 || !commentId) return;
    const workspace = dock.closest<HTMLElement>(
      "[data-document-scroll-container]",
    );
    if (!workspace) return;
    const anchor = Array.from(
      workspace.querySelectorAll<HTMLElement>(
        ".comment-anchor[data-comment-ids]",
      ),
    ).find((element) =>
      parseCommentIds(element.dataset.commentIds).includes(commentId),
    );
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const delta = getDockClearanceScrollDelta({
      anchorTop: rect.top,
      anchorBottom: rect.bottom,
      dockTop: dock.getBoundingClientRect().top,
      viewportTop: workspace.getBoundingClientRect().top,
    });
    if (delta !== 0) workspace.scrollBy({ top: delta, behavior: "auto" });
  }, [height, commentId, embeddedContainerRef]);

  return { dockRef, height };
}
