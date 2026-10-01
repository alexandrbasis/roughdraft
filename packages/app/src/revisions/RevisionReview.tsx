import { getSchema } from "@tiptap/core";
import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import {
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  History,
  ListFilter,
  RefreshCcw,
  ScanSearch,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { criticMarkdownToEditorState } from "../critic-markup";
import { createEditorExtensions } from "../editor-extensions";
import { loadRevisions } from "./revision-api";
import {
  createRevisionPlugin,
  revisionColorClass,
  revisionPluginKey,
  updateRevisionDecorations,
} from "./revision-decorations";
import { buildRevisionChanges } from "./revision-diff";
import type { DocumentRevision, RecoveryPoint, RevisionChange } from "./types";

interface RevisionReviewProps {
  documentPath: string;
  markdown: string;
  refreshKey: string;
  editor: Editor | null;
  legendContainer: HTMLElement | null;
  onRestore?: (content: string) => Promise<void>;
  restoreDisabledReason?: string;
}

function ReadOnlyVersionPreview({ content }: { content: string }) {
  const previewEditor = useEditor(
    {
      extensions: createEditorExtensions(""),
      content: criticMarkdownToEditorState(content).doc,
      editable: false,
      immediatelyRender: false,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: { class: "tiptap revision-history-tiptap" },
      },
    },
    [content],
  );
  return (
    <div
      data-testid="revision-history-preview"
      className="revision-history-reading max-h-[32dvh] min-h-40 overflow-auto rounded-md border bg-background p-4 md:max-h-[55vh]"
    >
      <EditorContent editor={previewEditor} />
    </div>
  );
}

type RevisionFilter =
  | { mode: "all" }
  | { mode: "latest" }
  | { mode: "custom"; numbers: number[] };

const authorLabel = (revision: DocumentRevision) =>
  revision.author?.trim() ||
  (revision.actor === "agent"
    ? "Agent"
    : revision.actor === "user"
      ? "You"
      : "Unknown author");

const versionTimeLabel = (revision: DocumentRevision) =>
  revision.completedAt
    ? `Completed ${new Date(revision.completedAt).toLocaleString()}`
    : `First seen ${new Date(revision.createdAt).toLocaleString()}`;

const sameRevisions = (left: DocumentRevision[], right: DocumentRevision[]) =>
  left.length === right.length &&
  left.every((revision, index) => {
    const next = right[index];
    return (
      revision.id === next.id &&
      revision.number === next.number &&
      revision.content === next.content &&
      revision.version === next.version &&
      revision.source === next.source &&
      revision.actor === next.actor &&
      revision.author === next.author &&
      revision.createdAt === next.createdAt &&
      revision.completedAt === next.completedAt
    );
  });

const recoveryReasonLabel = (reason: string) =>
  reason === "browser-draft"
    ? "Browser copy"
    : reason === "before-save"
      ? "Before save"
      : reason === "proposed-save"
        ? "Save proposal"
        : reason === "opened"
          ? "Opened copy"
          : "Recovery copy";

export function RevisionReview({
  documentPath,
  markdown,
  refreshKey,
  editor,
  legendContainer,
  onRestore,
  restoreDisabledReason,
}: RevisionReviewProps) {
  const [revisions, setRevisions] = useState<DocumentRevision[]>([]);
  const [recoveryPoints, setRecoveryPoints] = useState<RecoveryPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [visible, setVisible] = useState(true);
  const [filter, setFilter] = useState<RevisionFilter>({ mode: "all" });
  const [filterOpen, setFilterOpen] = useState(false);
  const [activeChangeId, setActiveChangeId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyTab, setHistoryTab] = useState<"versions" | "recovery">(
    "versions",
  );
  const [historySelectedId, setHistorySelectedId] = useState<string | null>(
    null,
  );
  const [recoverySelectedId, setRecoverySelectedId] = useState<string | null>(
    null,
  );
  const [previewSource, setPreviewSource] = useState(false);
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [restoreConfirmRefreshKey, setRestoreConfirmRefreshKey] = useState<
    string | null
  >(null);
  const [restorePending, setRestorePending] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
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
          sameRevisions(current, next.revisions) ? current : next.revisions,
        );
        setRecoveryPoints((current) =>
          current.length === next.recoveryPoints.length &&
          current.at(-1)?.id === next.recoveryPoints.at(-1)?.id
            ? current
            : next.recoveryPoints,
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

  const numberedRevisions = revisions;
  const latestNumber = numberedRevisions.at(-1)?.number ?? null;
  const selectedRevisions = useMemo(() => {
    if (filter.mode === "all") return null;
    if (filter.mode === "latest")
      return latestNumber === null ? [] : [latestNumber];
    return filter.numbers;
  }, [filter, latestNumber]);
  const changes = useMemo(
    () =>
      comparison.changes.filter(
        (change) =>
          selectedRevisions === null ||
          selectedRevisions.includes(change.revision),
      ),
    [comparison.changes, selectedRevisions],
  );
  const selectedVersion =
    revisions.find((revision) => revision.id === historySelectedId) ??
    revisions.at(-1);
  const selectedRecovery =
    recoveryPoints.find((point) => point.id === recoverySelectedId) ??
    recoveryPoints.at(-1);
  const historySelected =
    historyTab === "versions" ? selectedVersion : selectedRecovery;
  const restoreUnavailableReason =
    restoreDisabledReason ??
    (historySelected?.content === markdown
      ? "This is already the current document."
      : undefined);
  useEffect(() => {
    if (restoreConfirmRefreshKey === null || restorePending) return;
    if (refreshKey === restoreConfirmRefreshKey) return;
    setRestoreConfirmOpen(false);
    setRestoreConfirmRefreshKey(null);
    setHistoryNotice(
      "The document changed. Review the current content and confirm again.",
    );
  }, [refreshKey, restoreConfirmRefreshKey, restorePending]);
  const activeIndex = changes.findIndex(
    (change) => change.id === activeChangeId,
  );
  const countLabel = loading
    ? "Loading changes…"
    : activeIndex >= 0
      ? `${activeIndex + 1} of ${changes.length}`
      : `${changes.length} ${changes.length === 1 ? "change" : "changes"}`;
  const activeChange = changes[activeIndex < 0 ? 0 : activeIndex];
  const activeRevision = revisions.find(
    (revision) => revision.number === activeChange?.revision,
  );
  const navigationUnavailable = !changes.length || !visible;
  const comparisonUnavailable = !activeChange || !visible;
  const tooltipSuppressed =
    historyOpen || filterOpen || dialogOpen || restoreConfirmOpen;

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    updateRevisionDecorations(editor, {
      changes: comparison.changes,
      selectedRevisions,
      activeChangeId,
      visible,
    });
  }, [editor, comparison.changes, selectedRevisions, activeChangeId, visible]);

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

  const chooseFilter = (next: RevisionFilter) => {
    setFilter(next);
    setActiveChangeId(null);
  };
  const toggleVersion = (number: number) => {
    const current =
      selectedRevisions === null
        ? numberedRevisions.map((revision) => revision.number)
        : selectedRevisions;
    chooseFilter({
      mode: "custom",
      numbers: current.includes(number)
        ? current.filter((item) => item !== number)
        : [...current, number].sort((a, b) => a - b),
    });
  };
  const restore = async () => {
    if (
      !historySelected ||
      !onRestore ||
      restoreUnavailableReason ||
      restorePending
    )
      return;
    if (restoreConfirmRefreshKey !== refreshKey) {
      setRestoreConfirmOpen(false);
      setHistoryNotice(
        "The document changed. Review the current content and confirm again.",
      );
      return;
    }
    setRestorePending(true);
    setRestoreError(null);
    try {
      await onRestore(historySelected.content);
      setRestoreConfirmOpen(false);
      setRestoreConfirmRefreshKey(null);
      setHistoryOpen(false);
      setRetry((current) => current + 1);
    } catch (failure) {
      setRestoreError(
        failure instanceof Error
          ? failure.message
          : "Could not restore this version.",
      );
    } finally {
      setRestorePending(false);
    }
  };

  const failure = error ?? comparison.error;
  return (
    <div
      className="revision-review flex flex-col items-center gap-1"
      data-testid="revision-toolbar"
    >
      <span className="sr-only" data-testid="revision-count" aria-live="polite">
        {countLabel}
      </span>
      <Tooltip open={tooltipSuppressed ? false : undefined}>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="document-tool-button"
              data-testid="revision-history"
              aria-label="Version history"
              onClick={() => {
                setHistoryTab("versions");
                setHistorySelectedId(revisions.at(-1)?.id ?? null);
                setPreviewSource(false);
                setHistoryNotice(null);
                // Recovery copies can be archived without changing file bytes.
                setRetry((current) => current + 1);
                setHistoryOpen(true);
              }}
            >
              <History />
            </Button>
          }
        />
        <TooltipContent side="right">
          Preview completed versions and recovery copies. Restore into your
          current work.
        </TooltipContent>
      </Tooltip>
      <Popover open={filterOpen} onOpenChange={setFilterOpen}>
        <Tooltip open={tooltipSuppressed ? false : undefined}>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="document-tool-button"
                    data-testid="revision-filter"
                    aria-label="Filter version highlights"
                    aria-haspopup="dialog"
                  >
                    <ListFilter />
                  </Button>
                }
              />
            }
          />
          <TooltipContent side="right">
            Choose which completed versions' changes appear. The document stays
            unchanged. {countLabel}.
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          side="right"
          align="start"
          className="w-72"
          data-testid="revision-filter-popover"
        >
          <div className="mb-2 text-sm font-medium">Version highlights</div>
          <p className="mb-3 text-xs text-muted-foreground">
            {countLabel} shown
          </p>
          <div className="grid gap-1">
            <Button
              variant={filter.mode === "all" ? "secondary" : "ghost"}
              className="h-8 justify-start"
              data-testid="revision-filter-all"
              aria-pressed={filter.mode === "all"}
              onClick={() => chooseFilter({ mode: "all" })}
            >
              All versions
            </Button>
            <Button
              variant={filter.mode === "latest" ? "secondary" : "ghost"}
              className="h-8 justify-start"
              data-testid="revision-filter-latest"
              aria-pressed={filter.mode === "latest"}
              disabled={revisions.length < 2}
              onClick={() => chooseFilter({ mode: "latest" })}
            >
              Latest change · since previous version
            </Button>
          </div>
          <div className="my-3 border-t" />
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Choose versions
          </p>
          <div className="max-h-52 space-y-1 overflow-y-auto">
            {numberedRevisions.length ? (
              numberedRevisions.map((revision) => (
                <label
                  key={revision.id}
                  htmlFor={`revision-filter-checkbox-${revision.number}`}
                  className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-1 hover:bg-muted"
                  data-testid={`revision-filter-${revision.number}`}
                >
                  <Checkbox
                    id={`revision-filter-checkbox-${revision.number}`}
                    checked={
                      selectedRevisions === null ||
                      selectedRevisions.includes(revision.number)
                    }
                    onCheckedChange={() => toggleVersion(revision.number)}
                    aria-label={`Show V${revision.number} highlights`}
                  />
                  <span
                    className={`revision-swatch ${revisionColorClass(revision.number)}`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate text-xs">
                    V{revision.number} · {authorLabel(revision)}
                  </span>
                </label>
              ))
            ) : (
              <p className="text-xs text-muted-foreground">
                Changes appear after a later completed iteration.
              </p>
            )}
          </div>
          {failure ? (
            <div
              role="alert"
              data-testid="revision-error"
              className="mt-3 text-xs text-destructive"
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
          {!editor && changes.length > 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Inline highlights are available in reading view.
            </p>
          ) : null}
        </PopoverContent>
      </Popover>
      <Tooltip open={tooltipSuppressed ? false : undefined}>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              data-testid="revision-prev"
              aria-label="Previous change"
              aria-disabled={navigationUnavailable}
              className="document-tool-button aria-disabled:opacity-50"
              onClick={() => {
                if (!navigationUnavailable) navigate(-1);
              }}
            >
              <ArrowUp />
            </Button>
          }
        />
        <TooltipContent side="right">
          {navigationUnavailable
            ? visible
              ? "No highlighted changes to navigate."
              : "Show version highlights to navigate changes."
            : `Jump to the previous highlighted change. ${countLabel}.`}
        </TooltipContent>
      </Tooltip>
      <Tooltip open={tooltipSuppressed ? false : undefined}>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              data-testid="revision-next"
              aria-label="Next change"
              aria-disabled={navigationUnavailable}
              className="document-tool-button aria-disabled:opacity-50"
              onClick={() => {
                if (!navigationUnavailable) navigate(1);
              }}
            >
              <ArrowDown />
            </Button>
          }
        />
        <TooltipContent side="right">
          {navigationUnavailable
            ? visible
              ? "No highlighted changes to navigate."
              : "Show version highlights to navigate changes."
            : `Jump to the next highlighted change. ${countLabel}.`}
        </TooltipContent>
      </Tooltip>
      <Tooltip open={tooltipSuppressed ? false : undefined}>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              data-testid="revision-details"
              aria-label="Before and after"
              aria-disabled={comparisonUnavailable}
              className="document-tool-button aria-disabled:opacity-50"
              onClick={() => {
                if (!comparisonUnavailable && activeChange)
                  selectChange(activeChange.id);
              }}
            >
              <ScanSearch />
            </Button>
          }
        />
        <TooltipContent side="right">
          {comparisonUnavailable
            ? visible
              ? "Select a highlighted change to compare before and after."
              : "Show version highlights to compare a change."
            : "Compare the selected change before and after."}
        </TooltipContent>
      </Tooltip>
      <Tooltip open={tooltipSuppressed ? false : undefined}>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="document-tool-button"
              data-testid="revision-toggle"
              aria-label={
                visible ? "Hide version highlights" : "Show version highlights"
              }
              aria-pressed={visible}
              onClick={() => setVisible((current) => !current)}
            >
              {visible ? <Eye /> : <EyeOff />}
            </Button>
          }
        />
        <TooltipContent side="right">
          {visible
            ? "Hide version highlights. The document and saved versions stay unchanged."
            : "Show version highlights in the document."}
        </TooltipContent>
      </Tooltip>
      {legendContainer && revisions.length > 0
        ? createPortal(
            <ol
              className="revision-legend"
              data-testid="revision-legend"
              aria-label="Version colors"
            >
              {revisions.map((revision) => (
                <li key={revision.id}>
                  <Tooltip open={tooltipSuppressed ? false : undefined}>
                    <TooltipTrigger
                      render={
                        <Badge
                          tabIndex={0}
                          className={`revision-legend-badge ${revisionColorClass(revision.number)}`}
                          data-testid={`revision-legend-version-${revision.number}`}
                          aria-label={`V${revision.number} · ${authorLabel(revision)}`}
                        >
                          V{revision.number}
                        </Badge>
                      }
                    />
                    <TooltipContent side="right">
                      <span>
                        V{revision.number} · {authorLabel(revision)}
                        <br />
                        {versionTimeLabel(revision)}
                      </span>
                    </TooltipContent>
                  </Tooltip>
                </li>
              ))}
            </ol>,
            legendContainer,
          )
        : null}
      <Dialog
        open={historyOpen}
        onOpenChange={(open) => {
          if (!restorePending) setHistoryOpen(open);
        }}
      >
        <DialogContent
          data-testid="revision-history-dialog"
          overlayClassName="z-[80]"
          className="z-[80] max-h-[90dvh] max-w-5xl overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>Version history</DialogTitle>
            <DialogDescription>
              Completed versions and recovery copies are separate. Restoring
              saves content to your current work; Done completes the iteration.
            </DialogDescription>
          </DialogHeader>
          {failure ? (
            <div
              role="alert"
              data-testid="revision-history-error"
              className="text-sm text-destructive"
            >
              {failure}
              <Button
                variant="outline"
                size="sm"
                data-testid="revision-history-retry"
                onClick={() => setRetry((current) => current + 1)}
              >
                <RefreshCcw /> Retry
              </Button>
            </div>
          ) : null}
          {historyNotice ? (
            <p
              role="alert"
              data-testid="revision-history-notice"
              className="text-sm text-amber-700 dark:text-amber-300"
            >
              {historyNotice}
            </p>
          ) : null}
          <div role="group" aria-label="History type" className="flex gap-1">
            <Button
              variant={historyTab === "versions" ? "secondary" : "ghost"}
              size="sm"
              data-testid="revision-history-versions-tab"
              aria-pressed={historyTab === "versions"}
              onClick={() => setHistoryTab("versions")}
            >
              Completed versions
            </Button>
            <Button
              variant={historyTab === "recovery" ? "secondary" : "ghost"}
              size="sm"
              data-testid="revision-history-recovery-tab"
              aria-pressed={historyTab === "recovery"}
              onClick={() => setHistoryTab("recovery")}
            >
              Recovery points
              <span className="ml-1 text-muted-foreground">
                {recoveryPoints.length}
              </span>
            </Button>
          </div>
          <div className="grid min-h-0 gap-4 md:grid-cols-[12rem_minmax(0,1fr)]">
            <nav
              aria-label={
                historyTab === "versions"
                  ? "Completed versions"
                  : "Recovery points"
              }
              className="max-h-36 space-y-1 overflow-y-auto rounded-md border p-2 md:max-h-[55vh]"
            >
              {historyTab === "versions" && revisions.length ? (
                revisions.map((revision) => (
                  <Button
                    key={revision.id}
                    variant={
                      selectedVersion?.id === revision.id
                        ? "secondary"
                        : "ghost"
                    }
                    className="h-auto w-full justify-start px-2 py-2 text-left"
                    data-testid={`revision-history-${revision.number}`}
                    aria-current={
                      selectedVersion?.id === revision.id ? "true" : undefined
                    }
                    onClick={() => setHistorySelectedId(revision.id)}
                  >
                    <span className="min-w-0">
                      <span className="block font-semibold">
                        V{revision.number}
                      </span>
                      <span
                        className="block truncate text-[0.68rem] font-normal text-muted-foreground"
                        data-testid={`revision-history-author-${revision.number}`}
                      >
                        {authorLabel(revision)}
                      </span>
                      <span
                        className="block truncate text-[0.68rem] font-normal text-muted-foreground"
                        data-testid={`revision-history-time-${revision.number}`}
                      >
                        {versionTimeLabel(revision)}
                      </span>
                    </span>
                  </Button>
                ))
              ) : historyTab === "recovery" && recoveryPoints.length ? (
                recoveryPoints.map((point) => (
                  <Button
                    key={point.id}
                    variant={
                      selectedRecovery?.id === point.id ? "secondary" : "ghost"
                    }
                    className="h-auto w-full justify-start px-2 py-2 text-left"
                    data-testid={`revision-recovery-${point.id}`}
                    aria-current={
                      selectedRecovery?.id === point.id ? "true" : undefined
                    }
                    onClick={() => setRecoverySelectedId(point.id)}
                  >
                    <span className="min-w-0">
                      <span className="block font-semibold">
                        {recoveryReasonLabel(point.reason)}
                      </span>
                      <span className="block truncate text-[0.68rem] font-normal text-muted-foreground">
                        {new Date(point.createdAt).toLocaleString()}
                      </span>
                    </span>
                  </Button>
                ))
              ) : (
                <p className="px-1 text-xs text-muted-foreground">
                  {loading
                    ? "Loading history…"
                    : historyTab === "versions"
                      ? "No completed versions yet."
                      : "No recovery points yet."}
                </p>
              )}
            </nav>
            <section className="min-w-0" aria-label="Version preview">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                {historyTab === "versions" && selectedVersion ? (
                  <span
                    className={`revision-label ${revisionColorClass(selectedVersion.number)}`}
                  >
                    V{selectedVersion.number}
                  </span>
                ) : historyTab === "recovery" && selectedRecovery ? (
                  "Recovery point"
                ) : (
                  "Preview"
                )}
                {historyTab === "versions" && selectedVersion ? (
                  <span className="text-xs font-normal text-muted-foreground">
                    {authorLabel(selectedVersion)} ·{" "}
                    {versionTimeLabel(selectedVersion)}
                  </span>
                ) : historyTab === "recovery" && selectedRecovery ? (
                  <span className="text-xs font-normal text-muted-foreground">
                    {recoveryReasonLabel(selectedRecovery.reason)} ·{" "}
                    {new Date(selectedRecovery.createdAt).toLocaleString()}
                  </span>
                ) : null}
              </div>
              <div
                className="mb-2 flex gap-1"
                role="group"
                aria-label="Preview format"
              >
                <Button
                  variant={previewSource ? "ghost" : "secondary"}
                  size="sm"
                  data-testid="revision-preview-reading"
                  aria-pressed={!previewSource}
                  onClick={() => setPreviewSource(false)}
                >
                  Reading view
                </Button>
                <Button
                  variant={previewSource ? "secondary" : "ghost"}
                  size="sm"
                  data-testid="revision-preview-source"
                  aria-pressed={previewSource}
                  onClick={() => setPreviewSource(true)}
                >
                  Markdown source
                </Button>
              </div>
              {historySelected ? (
                previewSource ? (
                  <pre
                    data-testid="revision-history-source"
                    className="revision-comparison-text max-h-[32dvh] min-h-40 overflow-auto md:max-h-[55vh]"
                  >
                    {historySelected.content}
                  </pre>
                ) : (
                  <ReadOnlyVersionPreview
                    key={historySelected.id}
                    content={historySelected.content}
                  />
                )
              ) : (
                <p className="text-sm text-muted-foreground">
                  Choose an item to preview it.
                </p>
              )}
            </section>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHistoryOpen(false)}>
              Close
            </Button>
            <Button
              data-testid="revision-history-restore"
              disabled={
                !historySelected ||
                !onRestore ||
                Boolean(restoreUnavailableReason)
              }
              onClick={() => {
                setRestoreError(null);
                setHistoryNotice(null);
                setRestoreConfirmRefreshKey(refreshKey);
                setRestoreConfirmOpen(true);
              }}
            >
              {historyTab === "versions"
                ? "Restore this version…"
                : "Restore this recovery point…"}
            </Button>
          </DialogFooter>
          {restoreUnavailableReason ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="revision-restore-disabled-reason"
            >
              {restoreUnavailableReason}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={restoreConfirmOpen}
        onOpenChange={(open) => {
          if (!restorePending) setRestoreConfirmOpen(open);
        }}
      >
        <DialogContent
          data-testid="revision-restore-confirm"
          showCloseButton={!restorePending}
          overlayClassName="z-[80]"
          className="z-[80]"
        >
          <DialogHeader>
            <DialogTitle>
              Restore{" "}
              {historyTab === "versions" && selectedVersion
                ? `V${selectedVersion.number}`
                : "this recovery point"}
              ?
            </DialogTitle>
            <DialogDescription>
              The selected content will be saved to your current work. Existing
              completed versions stay in history. A new completed version
              appears only after Done.
            </DialogDescription>
          </DialogHeader>
          {restoreError ? (
            <p
              role="alert"
              className="text-sm text-destructive"
              data-testid="revision-restore-error"
            >
              {restoreError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={restorePending}
              onClick={() => {
                setRestoreConfirmOpen(false);
                setRestoreConfirmRefreshKey(null);
              }}
            >
              Cancel
            </Button>
            <Button
              data-testid="revision-restore-confirm-button"
              disabled={
                restorePending ||
                !onRestore ||
                Boolean(restoreUnavailableReason)
              }
              onClick={() => void restore()}
            >
              {restorePending ? "Restoring…" : "Restore to current work"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={dialogOpen && Boolean(activeChange)}
        onOpenChange={setDialogOpen}
      >
        <DialogContent
          data-testid="revision-dialog"
          overlayClassName="z-[80]"
          className="z-[80] max-h-[85dvh] max-w-3xl overflow-y-auto"
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 pr-7">
              {activeChange ? (
                <span
                  className={`revision-label ${revisionColorClass(activeChange.revision)}`}
                >
                  V{activeChange.revision}
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
                ? `${authorLabel(activeRevision)} · ${versionTimeLabel(activeRevision)}`
                : "Completed version"}
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
