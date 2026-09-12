interface DockClearanceInput {
  anchorTop: number;
  anchorBottom: number;
  dockTop: number;
  viewportTop: number;
  margin?: number;
}

// Move only enough to expose the selected text above the comment composer.
export function getDockClearanceScrollDelta({
  anchorTop,
  anchorBottom,
  dockTop,
  viewportTop,
  margin = 16,
}: DockClearanceInput): number {
  const top = viewportTop + margin;
  const bottom = dockTop - margin;
  if (bottom <= top) return 0;
  if (anchorBottom - anchorTop > bottom - top) {
    return Math.round(anchorTop - top);
  }
  if (anchorBottom > bottom) return Math.round(anchorBottom - bottom);
  if (anchorTop < top) return Math.round(anchorTop - top);
  return 0;
}
