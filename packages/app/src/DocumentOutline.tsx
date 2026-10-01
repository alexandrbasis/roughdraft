import { Button } from "./components/ui/button";
import type { DocumentOutlineHeading } from "./document-outline";
import { cn } from "./lib/utils";

interface OutlineNode {
  heading: DocumentOutlineHeading;
  children: OutlineNode[];
}

function outlineTree(headings: DocumentOutlineHeading[]) {
  const roots: OutlineNode[] = [];
  const parents: OutlineNode[] = [];
  for (const heading of headings) {
    const node = { heading, children: [] };
    while ((parents.at(-1)?.heading.level ?? 0) >= heading.level) {
      parents.pop();
    }
    (parents.at(-1)?.children ?? roots).push(node);
    parents.push(node);
  }
  return roots;
}

function OutlineEntries({
  nodes,
  parentLevel,
  activeId,
  onNavigate,
}: {
  nodes: OutlineNode[];
  parentLevel: number;
  activeId: string | null;
  onNavigate: (heading: DocumentOutlineHeading) => void;
}) {
  return (
    <ol className="m-0 list-none space-y-0.5 p-0">
      {nodes.map(({ heading, children }) => (
        <li
          key={heading.id}
          style={{
            marginInlineStart: `calc(${heading.level - parentLevel} * var(--document-outline-indent))`,
          }}
        >
          <Button
            type="button"
            variant="ghost"
            data-testid="document-outline-entry"
            data-level={heading.level}
            aria-label={heading.text || "Untitled section"}
            aria-current={activeId === heading.id ? "location" : undefined}
            title={heading.text || "Untitled section"}
            className={cn(
              "document-outline-entry h-auto min-h-8 w-full justify-start rounded-md px-2 py-1.5 text-start text-[0.8rem] leading-5 font-normal whitespace-normal text-muted-foreground",
              activeId === heading.id &&
                "bg-accent font-medium text-foreground",
            )}
            onClick={() => onNavigate(heading)}
          >
            <span className="min-w-0 wrap-anywhere">
              {heading.text || "Untitled section"}
            </span>
          </Button>
          {children.length > 0 ? (
            <OutlineEntries
              nodes={children}
              parentLevel={heading.level}
              activeId={activeId}
              onNavigate={onNavigate}
            />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function DocumentOutline({
  headings,
  activeId,
  disabled = false,
  onNavigate,
}: {
  headings: DocumentOutlineHeading[];
  activeId: string | null;
  disabled?: boolean;
  onNavigate: (heading: DocumentOutlineHeading) => void;
}) {
  return (
    <aside
      aria-label="Document outline"
      data-testid="document-outline-sidebar"
      className="document-outline-sidebar"
      inert={disabled}
    >
      <h2 className="px-3 pb-3 text-xs font-bold text-muted-foreground">
        Contents
      </h2>
      <nav
        aria-label="Document outline"
        data-testid="document-outline-navigation"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-2"
      >
        {headings.length > 0 ? (
          <OutlineEntries
            nodes={outlineTree(headings)}
            parentLevel={Math.min(...headings.map((heading) => heading.level))}
            activeId={activeId}
            onNavigate={onNavigate}
          />
        ) : (
          <p className="px-2 py-3 text-sm leading-6 text-muted-foreground">
            Add headings to see the outline.
          </p>
        )}
      </nav>
    </aside>
  );
}
