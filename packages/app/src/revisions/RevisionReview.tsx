import { getSchema } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import {
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  History,
  RefreshCcw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
} from "../components/ui/select";
import { criticMarkdownToEditorState } from "../critic-markup";
import { createEditorExtensions } from "../editor-extensions";
import { loadRevisions } from "./revision-api";
import {
  createRevisionPlugin,
  revisionPluginKey,
  updateRevisionDecorations,
} from "./revision-decorations";
import { buildRevisionChanges } from "./revision-diff";
import type { DocumentRevision, RevisionChange } from "./types";

interface RevisionReviewProps {
  documentPath: string;
  markdown: string;
  refreshKey: string;
  editor: Editor | null;
}

const colorClass = (revision: number) => `revision-color-${(revision - 1) % 6}`;
const sourceLabel = (source: DocumentRevision["source"]) =>
  source === "external"
    ? "External edit"
    : source === "review"
      ? "Review edit"
      : "Original";

export function RevisionReview({
  documentPath,
  markdown,
  refreshKey,
  editor,
}: RevisionReviewProps) {
  const [revisions, setRevisions] = useState<DocumentRevision[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [visible, setVisible] = useState(true);
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const [activeChangeId, setActiveChangeId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [documentTick, setDocumentTick] = useState(0);
  const fallbackSchema = useMemo(
    () => getSchema(createEditorExtensions("")),
    [],
  );

  useEffect(() => {
    // These values explicitly invalidate history after saves, reloads and retries.
    void refreshKey;
    void retry;
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await loadRevisions(documentPath, controller.signal);
        if (controller.signal.aborted) return;
        setRevisions((current) =>
          current.length === next.length &&
          current.at(-1)?.id === next.at(-1)?.id
            ? current
            : next,
        );
        setError(null);
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not load revisions.",
          );
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    // A loaded/saved file version and window focus reconcile changes missed while away.
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      window.removeEventListener("focus", refresh);
    };
  }, [documentPath, refreshKey, retry]);

  const selectChange = useCallback((id: string) => {
    setActiveChangeId(id);
    setDialogOpen(true);
  }, []);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.registerPlugin(createRevisionPlugin(selectChange));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onTransaction = ({
      transaction,
    }: {
      transaction: { docChanged: boolean };
    }) => {
      if (!transaction.docChanged) return;
      clearTimeout(timer);
      timer = setTimeout(() => setDocumentTick((tick) => tick + 1), 120);
    };
    editor.on("transaction", onTransaction);
    return () => {
      clearTimeout(timer);
      editor.off("transaction", onTransaction);
      if (!editor.isDestroyed) editor.unregisterPlugin(revisionPluginKey);
    };
  }, [editor, selectChange]);

  const comparison = useMemo(() => {
    // documentTick changes only after content transactions, never decoration updates.
    void documentTick;
    try {
      const schema = editor?.schema ?? fallbackSchema;
      const doc =
        editor && !editor.isDestroyed
          ? editor.state.doc
          : schema.nodeFromJSON(criticMarkdownToEditorState(markdown).doc);
      return {
        changes: buildRevisionChanges(revisions, doc, schema),
        error: null,
      };
    } catch {
      return {
        changes: [] as RevisionChange[],
        error: "Could not compare these document revisions.",
      };
    }
  }, [revisions, editor, markdown, fallbackSchema, documentTick]);

  const changes = useMemo(
    () =>
      comparison.changes.filter(
        (change) =>
          selectedRevision === null || change.revision === selectedRevision,
      ),
    [comparison.changes, selectedRevision],
  );
  const activeIndex = changes.findIndex(
    (change) => change.id === activeChangeId,
  );
  const activeChange = changes[activeIndex < 0 ? 0 : activeIndex];
  const activeRevision = revisions.find(
    (revision) => revision.number === activeChange?.revision,
  );

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    updateRevisionDecorations(editor, {
      changes: comparison.changes,
      selectedRevision,
      activeChangeId,
      visible,
    });
  }, [editor, comparison.changes, selectedRevision, activeChangeId, visible]);

  const navigate = (direction: number) => {
    if (!changes.length) return;
    const nextIndex =
      activeIndex < 0
        ? direction > 0
          ? 0
          : changes.length - 1
        : (activeIndex + direction + changes.length) % changes.length;
    const change = changes[nextIndex];
    setActiveChangeId(change.id);
    if (editor && !editor.isDestroyed) {
      const marker = [
        ...editor.view.dom.querySelectorAll<HTMLElement>(
          "[data-revision-change-id]",
        ),
      ].find((element) => element.dataset.revisionChangeId === change.id);
      marker?.scrollIntoView({ block: "center", behavior: "auto" });
    }
  };

  const failure = error ?? comparison.error;
  return (
    <div className="revision-review mb-3" data-testid="revision-toolbar">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-stone-600 dark:text-slate-300">
        <History className="size-3.5 shrink-0" aria-hidden="true" />
        <Select<string>
          value={selectedRevision === null ? "all" : String(selectedRevision)}
          onValueChange={(value) => {
            if (!value) return;
            setSelectedRevision(value === "all" ? null : Number(value));
            setActiveChangeId(null);
          }}
        >
          <SelectTrigger
            data-testid="revision-filter"
            aria-label="Filter document revisions"
            className="h-8 max-w-48 gap-2 px-2 text-xs"
          >
            <span className="truncate">
              {selectedRevision === null
                ? "All revisions"
                : `Revision ${selectedRevision}`}
            </span>
          </SelectTrigger>
          <SelectContent align="start" className="max-h-72 overflow-y-auto">
            <SelectItem value="all" data-testid="revision-filter-all">
              <SelectItemText>All revisions</SelectItemText>
            </SelectItem>
            {revisions
              .filter((revision) => revision.number > 0)
              .map((revision) => (
                <SelectItem
                  key={revision.id}
                  value={String(revision.number)}
                  data-testid={`revision-filter-${revision.number}`}
                >
                  <span
                    className={`revision-swatch ${colorClass(revision.number)}`}
                    aria-hidden="true"
                  />
                  <SelectItemText>{`R${revision.number} · ${sourceLabel(revision.source)}`}</SelectItemText>
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <span
          data-testid="revision-count"
          className="tabular-nums"
          aria-live="polite"
        >
          {loading
            ? "Loading changes…"
            : activeIndex >= 0
              ? `${activeIndex + 1} of ${changes.length}`
              : `${changes.length} ${changes.length === 1 ? "change" : "changes"}`}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            data-testid="revision-prev"
            aria-label="Previous change"
            disabled={!changes.length || !visible}
            onClick={() => navigate(-1)}
          >
            <ArrowUp />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            data-testid="revision-next"
            aria-label="Next change"
            disabled={!changes.length || !visible}
            onClick={() => navigate(1)}
          >
            <ArrowDown />
          </Button>
          <Button
            variant="ghost"
            className="h-8"
            data-testid="revision-details"
            disabled={!activeChange || !visible}
            onClick={() => {
              if (activeChange) selectChange(activeChange.id);
            }}
          >
            Before / after
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            data-testid="revision-toggle"
            aria-label={
              visible ? "Hide revision highlights" : "Show revision highlights"
            }
            aria-pressed={visible}
            onClick={() => setVisible((current) => !current)}
          >
            {visible ? <Eye /> : <EyeOff />}
          </Button>
        </div>
      </div>
      {failure ? (
        <div
          role="alert"
          className="mt-1 flex items-center gap-2 text-xs text-rose-700 dark:text-rose-300"
          data-testid="revision-error"
        >
          {failure}
          <Button
            variant="ghost"
            size="sm"
            data-testid="revision-retry"
            onClick={() => setRetry((current) => current + 1)}
          >
            <RefreshCcw /> Retry
          </Button>
        </div>
      ) : null}
      {!loading && revisions.length < 2 && !failure ? (
        <p className="mt-1 text-xs text-stone-400 dark:text-slate-400">
          Changes will appear after the next saved revision.
        </p>
      ) : null}
      {!editor && changes.length > 0 ? (
        <p className="mt-1 text-xs text-stone-400 dark:text-slate-400">
          Inline highlights are available in reading view.
        </p>
      ) : null}
      <Dialog
        open={dialogOpen && Boolean(activeChange)}
        onOpenChange={setDialogOpen}
      >
        <DialogContent
          data-testid="revision-dialog"
          className="max-h-[85vh] max-w-3xl overflow-y-auto"
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 pr-7">
              {activeChange ? (
                <span
                  className={`revision-label ${colorClass(activeChange.revision)}`}
                >
                  R{activeChange.revision}
                </span>
              ) : null}
              {activeChange?.kind === "deletion"
                ? "Deleted text"
                : activeChange?.kind === "addition"
                  ? "Added text"
                  : "Changed text"}
            </DialogTitle>
            <DialogDescription>
              {activeRevision
                ? `${sourceLabel(activeRevision.source)} · ${new Date(activeRevision.createdAt).toLocaleString()}`
                : "Document revision"}
            </DialogDescription>
          </DialogHeader>
          {activeChange && activeChange.before === activeChange.after ? (
            <p className="text-sm text-muted-foreground">
              Formatting or document structure changed; the wording is
              unchanged.
            </p>
          ) : null}
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <section className="min-w-0">
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                Before
              </h3>
              {activeChange?.beforeFormat ? (
                <p
                  data-testid="revision-before-format"
                  className="mb-2 text-sm font-medium"
                >
                  {activeChange.beforeFormat}
                </p>
              ) : null}
              <pre
                data-testid="revision-before"
                className="revision-comparison-text"
              >
                {activeChange?.before.trim()
                  ? activeChange.before
                  : activeChange?.beforeFormat
                    ? "Text unchanged."
                    : "No previous text."}
              </pre>
            </section>
            <section className="min-w-0">
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                After
              </h3>
              {activeChange?.afterFormat ? (
                <p
                  data-testid="revision-after-format"
                  className="mb-2 text-sm font-medium"
                >
                  {activeChange.afterFormat}
                </p>
              ) : null}
              <pre
                data-testid="revision-after"
                className="revision-comparison-text"
              >
                {activeChange?.after.trim()
                  ? activeChange.after
                  : activeChange?.afterFormat
                    ? "Text unchanged."
                    : "Removed in this revision."}
              </pre>
            </section>
          </div>
          <DialogClose
            render={
              <Button
                variant="outline"
                data-testid="revision-dialog-close"
                className="justify-self-end"
              />
            }
          >
            Close comparison
          </DialogClose>
        </DialogContent>
      </Dialog>
    </div>
  );
}
