import type { Editor } from "@tiptap/react";
import {
  AlertTriangle,
  Check,
  CheckCheck,
  ChevronDown,
  CodeXml,
  Copy,
  Eye,
  FileText,
  Loader2,
  MessageSquarePlus,
  PencilLine,
  RefreshCcw,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocumentEditorViewMode } from "./app-navigation";
import { CommentComposer } from "./CommentComposer";
import { DocumentOutline } from "./DocumentOutline";
import { writeTextToClipboard } from "./clipboard";
import { RemoteSessionBanner } from "./components/RemoteSessionBanner";
import { Button } from "./components/ui/button";
import { ProgressRing } from "./components/ui/progress-ring";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
} from "./components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./components/ui/tooltip";
import {
  criticMarkdownHasReviewRail,
  criticMarkdownToRenderedHtml,
} from "./critic-markup";
import {
  createBrowserDraftStorage,
  createDraftRecord,
  type DraftStorage,
  DraftStorageError,
  getDraftRevision,
  getDraftTabId,
  inspectDraftRecovery,
  isDraftStorageKeyForDocument,
  pageSnapshot,
  type StoredDraft,
} from "./draft-storage";
import { cn } from "./lib/utils";
import type {
  DocumentOutlineHeading,
  MarkdownCodeEditorNavigation,
} from "./document-outline";
import {
  type DocumentInteractionMode,
  type DocumentSaveController,
  type DocumentSaveState,
  DOCUMENT_AUTOSAVE_DELAY_MS,
  PageCard,
} from "./PageCard";
import { RobotsHighFiveToy } from "./RobotsHighFiveToy";
import { RevisionReview } from "./revisions/RevisionReview";
import {
  createServerDraftClient,
  type ServerDraft,
  type ServerDraftClient,
} from "./server-draft-client";
import type { CompleteReviewOptions, Page, StorageBackend } from "./storage";
import { useDocumentOutlineNavigation } from "./useDocumentOutlineNavigation";

type DiskChangeState = "clean" | "changed" | "conflict" | "paused";
type DraftRecoveryState =
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "safe"; draft: StoredDraft }
  | {
      kind: "disk-changed";
      draft: StoredDraft;
      decision: "pending" | "local";
    };
type ReviewHandoffState =
  | "idle"
  | "notifying"
  | "notified"
  | "undelivered"
  | "completed"
  | "error";
type FileCopyAction = "path" | "filename" | "markdown" | "rich-text";
const FILE_COPY_PREVIEW_MAX_LENGTH = 34;
const reviewCompleteTitles = [
  "Great work!",
  "Nice one!",
  "Well done!",
  "All set!",
  "Review complete!",
  "That’ll do!",
  "Lovely stuff!",
  "Job done!",
  "Done and dusted!",
  "Nailed it!",
  "Good stuff!",
  "Sorted!",
  "Cracking work!",
  "Top work!",
  "Brilliant!",
  "Ace!",
  "Spot on!",
  "Beauty!",
  "Too easy!",
  "Good on ya!",
  "You’re golden!",
  "That’s the ticket!",
  "And that’s that!",
  "Wrapped!",
  "In the bag!",
  "Shipshape!",
  "Right as rain!",
] as const;
type ReviewCompleteTitle = (typeof reviewCompleteTitles)[number];

function buildReviewHandoffCopyMessage(documentPath: string) {
  return `I am done reviewing this file: ${documentPath}`;
}

function getRandomReviewCompleteTitle(random: () => number = Math.random) {
  const index = Math.floor(random() * reviewCompleteTitles.length);
  return reviewCompleteTitles[Math.min(index, reviewCompleteTitles.length - 1)];
}

function getRandomReviewCompleteTitleExcept(
  currentTitle: ReviewCompleteTitle,
  random: () => number = Math.random,
): ReviewCompleteTitle {
  const otherTitles = reviewCompleteTitles.filter(
    (title) => title !== currentTitle,
  );
  if (otherTitles.length === 0) return currentTitle;

  const index = Math.floor(random() * otherTitles.length);
  return otherTitles[Math.min(index, otherTitles.length - 1)];
}

const documentInteractionModeOptions = [
  { value: "editing", label: "Editing", Icon: PencilLine },
  { value: "suggesting", label: "Suggesting", Icon: MessageSquarePlus },
  { value: "viewing", label: "Viewing", Icon: Eye },
] satisfies {
  value: DocumentInteractionMode;
  label: string;
  Icon: typeof Eye;
}[];

const conflictNoticeCopy: Record<
  Exclude<DiskChangeState, "clean">,
  {
    title: string;
    body: string;
  }
> = {
  changed: {
    title: "File changed on disk",
    body: "Choose the file from disk or your edits to continue. The other copy will remain available for recovery.",
  },
  conflict: {
    title: "Save conflict",
    body: "This file changed on disk while you have unsaved edits. Choose which text to continue with. Both copies will remain available for recovery.",
  },
  paused: {
    title: "Autosave paused",
    body: "Your latest edits are not in the document. Choose the file from disk or your edits to resume saving; the other copy remains available for recovery.",
  },
};

const fileCopyMenuOptions = [
  { action: "path", label: "Path" },
  { action: "filename", label: "Filename" },
  { action: "markdown", label: "Markdown" },
  { action: "rich-text", label: "Rich text" },
] satisfies {
  action: FileCopyAction;
  label: string;
}[];

function formatFileCopyPreview(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= FILE_COPY_PREVIEW_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, FILE_COPY_PREVIEW_MAX_LENGTH - 1)}...`;
}

async function writePlainTextToClipboard(text: string) {
  await writeTextToClipboard(text);
}

function markdownToPlainText(markdown: string) {
  const template = document.createElement("template");
  template.innerHTML = markdownToCleanRichHtml(markdown);
  return (template.content.textContent ?? "").trimEnd();
}

function unwrapElement(element: HTMLElement) {
  element.replaceWith(...element.childNodes);
}

function markdownToCleanRichHtml(markdown: string) {
  const template = document.createElement("template");
  template.innerHTML = criticMarkdownToRenderedHtml(markdown).html;

  for (const element of Array.from(
    template.content.querySelectorAll<HTMLElement>(
      "[data-comment-anchorless='true']",
    ),
  )) {
    element.remove();
  }

  for (const element of Array.from(
    template.content.querySelectorAll<HTMLElement>("[data-comment-ids]"),
  )) {
    unwrapElement(element);
  }

  for (const element of Array.from(
    template.content.querySelectorAll<HTMLElement>(
      "[data-critic-change-kind='addition'], [data-critic-change-kind='substitution-new']",
    ),
  )) {
    element.remove();
  }

  for (const element of Array.from(
    template.content.querySelectorAll<HTMLElement>("[data-critic-change-kind]"),
  )) {
    unwrapElement(element);
  }

  return template.innerHTML;
}

async function writeRichTextToClipboard(markdown: string) {
  const clipboardWithRichText = navigator.clipboard as Clipboard | undefined;
  const clipboardWithRichTextApi = clipboardWithRichText as
    | (Clipboard & {
        write?: Clipboard["write"];
      })
    | undefined;
  const html = markdownToCleanRichHtml(markdown);
  const plainText = markdownToPlainText(markdown);

  if (clipboardWithRichTextApi?.write && typeof ClipboardItem !== "undefined") {
    await clipboardWithRichTextApi.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plainText], { type: "text/plain" }),
      }),
    ]);
    return;
  }

  await writePlainTextToClipboard(plainText);
}

function getSaveStatusViewModel(
  saveState: DocumentSaveState,
  diskChangeState: DiskChangeState,
) {
  if (diskChangeState === "conflict") {
    return {
      label: "Save conflict",
      ariaLabel: "Save conflict",
      tone: "warning" as const,
      Icon: AlertTriangle,
    };
  }

  if (diskChangeState === "changed") {
    return {
      label: "File changed on disk",
      ariaLabel: "File changed on disk",
      tone: "warning" as const,
      Icon: AlertTriangle,
    };
  }

  if (diskChangeState === "paused") {
    return {
      label: "Autosave paused",
      ariaLabel: "Autosave paused",
      tone: "warning" as const,
      Icon: AlertTriangle,
    };
  }

  if (saveState === "saving") {
    return {
      label: "Saving",
      ariaLabel: "Saving",
      tone: "neutral" as const,
      Icon: Loader2,
    };
  }

  if (saveState === "error") {
    return {
      label: "Save failed",
      ariaLabel: "Save failed",
      tone: "danger" as const,
      Icon: AlertTriangle,
    };
  }

  if (saveState === "unsaved") {
    return {
      label: "Unsaved changes",
      ariaLabel: "Unsaved changes",
      tone: "neutral" as const,
      Icon: PencilLine,
    };
  }

  return {
    label: "Saved",
    ariaLabel: "Saved",
    tone: "success" as const,
    Icon: Check,
  };
}

function AutosaveCountdown({
  deadline,
  active,
  className,
}: {
  deadline: number | null;
  active: boolean;
  className: string;
}) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!active || deadline === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => {
      const currentTime = Date.now();
      setNow(currentTime);
      if (currentTime >= deadline) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, [active, deadline]);

  const progress =
    deadline === null
      ? 100
      : 100 * (1 - (deadline - now) / DOCUMENT_AUTOSAVE_DELAY_MS);

  return (
    <ProgressRing
      value={progress}
      aria-label="Autosave countdown"
      aria-hidden={!active}
      aria-live="off"
      data-testid={active ? "document-save-status-icon" : undefined}
      className={className}
    />
  );
}

export function DocumentSaveStatusIndicator({
  saveState,
  diskChangeState,
  autosaveDeadline = null,
  detail,
  savedLabel,
}: {
  saveState: DocumentSaveState;
  diskChangeState: DiskChangeState;
  autosaveDeadline?: number | null;
  detail?: string;
  savedLabel?: string;
}) {
  const saveStatus = getSaveStatusViewModel(saveState, diskChangeState);
  const label =
    saveStatus.label === "Saved" && savedLabel ? savedLabel : saveStatus.label;
  const SaveStatusIcon = saveStatus.Icon;
  const showCountdown =
    saveStatus.label === "Unsaved changes" && autosaveDeadline !== null;
  const showSaved = saveStatus.label === "Saved";
  const showOtherIcon = !showCountdown && !showSaved;
  const iconTransition =
    "absolute inset-0 size-full transition-[opacity,filter,scale] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none";
  const hiddenIcon = "scale-[0.25] opacity-0 blur-[4px]";

  return (
    <span
      data-testid="document-save-status"
      role="status"
      aria-label={label}
      className={cn(
        "inline-flex max-w-[min(24rem,calc(100vw-11rem))] min-h-7 items-start gap-1.5 rounded-md bg-background/95 px-2 py-1 text-xs leading-4 text-muted-foreground shadow-sm",
        saveStatus.tone === "warning" && "text-amber-600 dark:text-amber-400",
        saveStatus.tone === "danger" && "text-red-600 dark:text-red-400",
      )}
    >
      <span className="relative mt-px size-3.5 shrink-0">
        <AutosaveCountdown
          deadline={autosaveDeadline}
          active={showCountdown}
          className={cn(iconTransition, !showCountdown && hiddenIcon)}
        />
        <Check
          data-testid={showSaved ? "document-save-status-icon" : undefined}
          className={cn(iconTransition, !showSaved && hiddenIcon)}
          aria-hidden="true"
        />
        <SaveStatusIcon
          data-testid={showOtherIcon ? "document-save-status-icon" : undefined}
          className={cn(
            iconTransition,
            !showOtherIcon && hiddenIcon,
            saveStatus.label === "Saving" &&
              "animate-spin motion-reduce:animate-none",
          )}
          aria-hidden="true"
        />
      </span>
      <span>
        <span className="block font-medium">{label}</span>
        {detail ? (
          <span className="mt-0.5 block text-[11px] leading-4">{detail}</span>
        ) : null}
      </span>
    </span>
  );
}

export function isReviewHandoffDisabled({
  saveState,
  documentDiskChangeState,
  reviewHandoffState,
}: {
  saveState: DocumentSaveState;
  documentDiskChangeState: DiskChangeState;
  reviewHandoffState: ReviewHandoffState;
}) {
  // Transient save states ("saving"/"unsaved") intentionally do NOT disable the
  // button. Disabling on them dims the whole control on every keystroke while
  // autosave debounces. Instead the button stays enabled and flushes the
  // pending save on click, so the agent still receives the latest content.
  return (
    saveState === "error" ||
    reviewHandoffState !== "idle" ||
    documentDiskChangeState !== "clean"
  );
}

export function getReviewHandoffButtonLabel({
  reviewHandoffState,
  documentChangedSinceOpen,
}: {
  reviewHandoffState: ReviewHandoffState;
  documentChangedSinceOpen: boolean;
}) {
  return reviewHandoffState === "notifying"
    ? "Sending"
    : reviewHandoffState === "notified"
      ? "Sent"
      : reviewHandoffState === "undelivered"
        ? "Not sent, but saved"
        : reviewHandoffState === "completed"
          ? "Review completed"
          : reviewHandoffState === "error"
            ? "Not sent"
            : documentChangedSinceOpen
              ? "I'm done"
              : "Approve";
}

export function shouldLatchDocumentChangedSinceOpen({
  isDirty,
  documentChangeTrackingReady,
}: {
  isDirty: boolean;
  documentChangeTrackingReady: boolean;
}) {
  return isDirty && documentChangeTrackingReady;
}

interface DocumentWorkspaceProps {
  documentPage: Page | null;
  activeDocumentPath: string | null;
  documentCopyPath: string | null;
  documentFilenameLabel: string;
  draftStorageKey: string;
  persistDraft?: boolean;
  documentEditorViewMode: DocumentEditorViewMode;
  onDocumentEditorViewModeChange: (mode: DocumentEditorViewMode) => void;
  onSaveDocument: (
    id: string,
    content: string,
  ) => Promise<Page | undefined> | Promise<void>;
  onDocumentSaveStateChange: (state: DocumentSaveState) => void;
  onDocumentDirtyStateChange: (isDirty: boolean) => void;
  onDocumentLocalContentChange: (markdown: string) => void;
  documentDiskChangeState: DiskChangeState;
  documentForceResetKey: string | null;
  reviewOpenRequestKey?: number;
  onReloadDocumentFromDisk: () => void | Promise<void>;
  onKeepEditingWithoutAutosave: () => void;
  onOverwriteDocumentOnDisk: () => void | Promise<void>;
  onCompleteReview: (
    options?: CompleteReviewOptions,
  ) => Promise<{ delivered: boolean }>;
  backend: StorageBackend | null;
}

export function DocumentWorkspace({
  documentPage,
  activeDocumentPath,
  documentCopyPath,
  documentFilenameLabel,
  draftStorageKey,
  persistDraft = true,
  documentEditorViewMode,
  onDocumentEditorViewModeChange,
  onSaveDocument,
  onDocumentSaveStateChange,
  onDocumentDirtyStateChange,
  onDocumentLocalContentChange,
  documentDiskChangeState,
  documentForceResetKey,
  reviewOpenRequestKey = 0,
  onReloadDocumentFromDisk,
  onKeepEditingWithoutAutosave,
  onOverwriteDocumentOnDisk,
  onCompleteReview,
  backend,
}: DocumentWorkspaceProps) {
  const [documentInteractionMode, setDocumentInteractionMode] =
    useState<DocumentInteractionMode>("suggesting");
  const [saveState, setSaveState] = useState<DocumentSaveState>("saved");
  const [autosaveDeadline, setAutosaveDeadline] = useState<number | null>(null);
  const [revisionEditor, setRevisionEditor] = useState<Editor | null>(null);
  const [outlineHeadings, setOutlineHeadings] = useState<
    DocumentOutlineHeading[]
  >([]);
  const [codeNavigation, setCodeNavigation] =
    useState<MarkdownCodeEditorNavigation | null>(null);
  const [workspaceElement, setWorkspaceElement] =
    useState<HTMLDivElement | null>(null);
  const [revisionLegendContainer, setRevisionLegendContainer] =
    useState<HTMLDivElement | null>(null);
  const [reviewHandoffState, setReviewHandoffState] =
    useState<ReviewHandoffState>(
      documentPage?.reviewState === "completed" ? "completed" : "idle",
    );
  const reviewHandoffDocumentIdentityRef = useRef<string | null>(null);
  const previousReviewOpenRequestKeyRef = useRef(reviewOpenRequestKey);
  const [reviewWatcherCount, setReviewWatcherCount] = useState(0);
  const [reviewHandoffPopoverOpen, setReviewHandoffPopoverOpen] =
    useState(false);
  const [reviewCompleteTitle, setReviewCompleteTitle] = useState(() =>
    getRandomReviewCompleteTitle(),
  );
  const [fileCopyMenuOpen, setFileCopyMenuOpen] = useState(false);
  const [copiedFileAction, setCopiedFileAction] =
    useState<FileCopyAction | null>(null);
  const [overallComment, setOverallComment] = useState("");
  const [overallCommentUploading, setOverallCommentUploading] = useState(false);
  const [documentChangedSinceOpen, setDocumentChangedSinceOpen] =
    useState(false);
  const [draftRecoveryState, setDraftRecoveryState] =
    useState<DraftRecoveryState>({ kind: "checking" });
  const [draftContentOverride, setDraftContentOverride] = useState<
    string | null
  >(null);
  const [draftStorageError, setDraftStorageError] =
    useState<DraftStorageError | null>(null);
  const [otherTabDraftPending, setOtherTabDraftPending] = useState(false);
  const [serverDrafts, setServerDrafts] = useState<ServerDraft[]>([]);
  const serverDraftsRef = useRef<ServerDraft[]>([]);
  const [serverDraftError, setServerDraftError] = useState<string | null>(null);
  const [mirroredDraftRevision, setMirroredDraftRevision] = useState<
    string | null
  >(null);
  const [draftActionPending, setDraftActionPending] = useState(false);
  const [draftActionError, setDraftActionError] = useState<string | null>(null);
  const [recoveredFromServer, setRecoveredFromServer] = useState(false);
  const adoptedSourceRef = useRef<StoredDraft | null>(null);
  const serverClient = useMemo(
    () =>
      persistDraft && backend && documentCopyPath
        ? createServerDraftClient(backend.info, documentCopyPath)
        : null,
    [persistDraft, backend, documentCopyPath],
  );
  const serverClientRef = useRef(serverClient);
  serverClientRef.current = serverClient;
  const sawNoWatcherAfterNotifiedRef = useRef(false);
  const copiedFileActionTimeoutRef = useRef<number | null>(null);
  const saveControllerRef = useRef<DocumentSaveController | null>(null);
  const documentChangeTrackingReadyRef = useRef(false);
  const draftStorageRef = useRef<DraftStorage | null>(null);
  const draftStorageKeyRef = useRef<string | null>(null);
  const draftInitializedPageRef = useRef(documentPage);
  const draftBaseRef = useRef<ReturnType<typeof pageSnapshot> | null>(null);
  const draftRecordRef = useRef<StoredDraft | null>(null);
  // Server list responses can retain an older copy after our active draft saves.
  // Remember copies made by this editor without hiding recovery after a reopen.
  const ownedDraftRevisionsRef = useRef(new Set<string>());
  const draftTabIdRef = useRef<string | null>(null);
  const latestLocalContentRef = useRef<string | null>(null);

  if (!draftTabIdRef.current && persistDraft) {
    draftTabIdRef.current = getDraftTabId();
  }

  const documentDraftStorageKey = useMemo(() => {
    if (
      !persistDraft ||
      !backend ||
      !activeDocumentPath ||
      typeof draftStorageKey !== "string" ||
      !draftStorageKey.trim()
    ) {
      return null;
    }
    return draftStorageKey.trim();
  }, [activeDocumentPath, backend, draftStorageKey, persistDraft]);

  const updateServerDrafts = useCallback((drafts: ServerDraft[]) => {
    serverDraftsRef.current = drafts;
    setServerDrafts(drafts);
  }, []);

  const mirrorDraft = useCallback((draft: StoredDraft) => {
    const client = serverClientRef.current;
    if (!client) return;
    ownedDraftRevisionsRef.current.add(draft.revision);
    void client
      .put(draft)
      .then((saved) => {
        if (serverClientRef.current !== client || !saved) return;
        // Acknowledging an older revision must not clear a newer failure.
        if (draftRecordRef.current?.revision === draft.revision) {
          setMirroredDraftRevision(draft.revision);
          setServerDraftError(null);
        }
      })
      .catch(() => {
        if (
          serverClientRef.current === client &&
          draftRecordRef.current?.revision === draft.revision
        ) {
          setServerDraftError(
            "The server draft copy failed. Your browser draft is still available in this browser.",
          );
        }
      });
  }, []);

  const removeServerDraft = useCallback(
    (
      draft: StoredDraft,
      client: ServerDraftClient | null = serverClientRef.current,
    ) => {
      if (!client) return;
      void client
        .remove(draft)
        .then(async (deleted) => {
          if (serverClientRef.current !== client) return;
          if (deleted) {
            updateServerDrafts(
              serverDraftsRef.current.filter(
                (copy) =>
                  copy.tabId !== draft.tabId ||
                  copy.revision !== draft.revision,
              ),
            );
          } else {
            const remaining = await client.list();
            if (serverClientRef.current === client)
              updateServerDrafts(remaining);
          }
        })
        .catch(() => {
          if (serverClientRef.current === client)
            setServerDraftError(
              "Could not remove the old server draft copy. It may still be offered for recovery.",
            );
        });
    },
    [updateServerDrafts],
  );

  useEffect(() => {
    let cancelled = false;
    updateServerDrafts([]);
    setServerDraftError(null);
    setRecoveredFromServer(false);
    adoptedSourceRef.current = null;
    if (!serverClient) return;
    void serverClient
      .list()
      .then((drafts) => {
        if (!cancelled) updateServerDrafts(drafts);
      })
      .catch(() => {
        if (!cancelled)
          setServerDraftError(
            "Could not check server drafts. Browser draft recovery is still available.",
          );
      });
    const retry = () => {
      const draft = draftRecordRef.current;
      if (draft) mirrorDraft(draft);
    };
    window.addEventListener("online", retry);
    return () => {
      cancelled = true;
      window.removeEventListener("online", retry);
    };
  }, [serverClient, updateServerDrafts, mirrorDraft]);

  const reportDraftStorageError = useCallback(
    (error: unknown) => {
      const nextError =
        error instanceof DraftStorageError
          ? error
          : new DraftStorageError(
              "unavailable",
              "Browser draft storage is unavailable. Your local edits are still open, but they cannot be recovered after a reload.",
              error,
            );
      setDraftStorageError(nextError);
      onDocumentSaveStateChange("error");
      return nextError;
    },
    [onDocumentSaveStateChange],
  );

  const handleSaveStateChange = useCallback(
    (state: DocumentSaveState) => {
      const effectiveState = draftStorageError ? "error" : state;
      setSaveState(effectiveState);
      onDocumentSaveStateChange(effectiveState);
    },
    [draftStorageError, onDocumentSaveStateChange],
  );

  useEffect(() => {
    if (!documentPage || !documentDraftStorageKey || !backend) {
      draftStorageKeyRef.current = null;
      draftInitializedPageRef.current = null;
      draftBaseRef.current = null;
      draftRecordRef.current = null;
      ownedDraftRevisionsRef.current.clear();
      setDraftRecoveryState({ kind: "none" });
      setDraftContentOverride(null);
      return;
    }

    // Recovery is an editor-open operation. An autosave acknowledgement is
    // a new page object too, but must not recover (or discard) newer typing.
    if (draftStorageKeyRef.current === documentDraftStorageKey) {
      if (draftInitializedPageRef.current !== documentPage) {
        draftInitializedPageRef.current = documentPage;
        draftBaseRef.current = pageSnapshot(documentPage);
        if (!draftRecordRef.current) {
          latestLocalContentRef.current = documentPage.content;
          setDraftContentOverride(null);
        }
      }
      return;
    }
    draftInitializedPageRef.current = documentPage;
    draftStorageKeyRef.current = documentDraftStorageKey;
    draftBaseRef.current = pageSnapshot(documentPage);
    latestLocalContentRef.current = documentPage.content;
    draftRecordRef.current = null;
    ownedDraftRevisionsRef.current.clear();
    setDraftContentOverride(null);
    setOtherTabDraftPending(false);
    setDraftRecoveryState({ kind: "checking" });

    let storage = draftStorageRef.current;
    try {
      storage ??= createBrowserDraftStorage();
      draftStorageRef.current = storage;
      const draftTabId = draftTabIdRef.current;
      if (!draftTabId) throw new Error("Draft tab identity is unavailable");
      const draft = storage.read(documentDraftStorageKey, draftTabId);
      const foreignDraftPending = storage
        .list(documentDraftStorageKey)
        .some((candidate) => candidate.tabId !== draftTabId);
      const recovery = inspectDraftRecovery(draft, pageSnapshot(documentPage));

      draftRecordRef.current = draft;
      if (draft) mirrorDraft(draft);
      setOtherTabDraftPending(foreignDraftPending);
      setDraftStorageError(null);

      if (
        recovery.kind === "safe" &&
        recovery.draft.content !== documentPage.content
      ) {
        setDraftContentOverride(recovery.draft.content);
        setDraftRecoveryState(recovery);
        latestLocalContentRef.current = recovery.draft.content;
        onDocumentLocalContentChange(recovery.draft.content);
        onDocumentDirtyStateChange(true);
        onDocumentSaveStateChange("unsaved");
      } else if (recovery.kind === "disk-changed") {
        setDraftRecoveryState({
          kind: "disk-changed",
          draft: recovery.draft,
          decision: "pending",
        });
      } else {
        setDraftRecoveryState({ kind: "none" });
      }
    } catch (error) {
      reportDraftStorageError(error);
      setDraftRecoveryState({ kind: "none" });
    }
  }, [
    backend,
    mirrorDraft,
    documentDraftStorageKey,
    documentPage,
    onDocumentDirtyStateChange,
    onDocumentLocalContentChange,
    onDocumentSaveStateChange,
    reportDraftStorageError,
  ]);

  useEffect(() => {
    const storageKey = documentDraftStorageKey;
    if (!storageKey || typeof window === "undefined") return;

    const handleStorage = (event: StorageEvent) => {
      if (!event.key || !isDraftStorageKeyForDocument(event.key, storageKey)) {
        return;
      }

      try {
        const currentTabId = draftTabIdRef.current;
        const foreignDraftPending =
          draftStorageRef.current
            ?.list(storageKey)
            .some((draft) => draft.tabId !== currentTabId) ?? false;
        setOtherTabDraftPending(foreignDraftPending);
      } catch (error) {
        reportDraftStorageError(error);
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [documentDraftStorageKey, reportDraftStorageError]);

  const handleDocumentLocalContentChange = useCallback(
    (markdown: string) => {
      if (
        markdown !== latestLocalContentRef.current &&
        (reviewHandoffState === "notified" ||
          reviewHandoffState === "undelivered" ||
          reviewHandoffState === "completed")
      ) {
        setReviewHandoffState("idle");
        setReviewHandoffPopoverOpen(false);
      }
      onDocumentLocalContentChange(markdown);
      latestLocalContentRef.current = markdown;

      const storage = draftStorageRef.current;
      const storageKey = draftStorageKeyRef.current;
      const base = draftBaseRef.current;
      const tabId = draftTabIdRef.current;
      if (!storage || !storageKey || !base || !tabId) return;

      const draft = createDraftRecord({
        storageKey,
        content: markdown,
        base,
        revision: getDraftRevision(tabId),
        tabId,
      });

      draftRecordRef.current = draft;
      mirrorDraft(draft);
      try {
        storage.write(draft);
        setDraftStorageError(null);
        setOtherTabDraftPending(
          storage
            .list(storageKey)
            .some((candidate) => candidate.tabId !== tabId),
        );
        setDraftRecoveryState((current) => {
          if (current.kind === "disk-changed") {
            return { ...current, draft };
          }
          return current.kind === "safe" ? { kind: "safe", draft } : current;
        });
      } catch (error) {
        reportDraftStorageError(error);
      }
    },
    [
      mirrorDraft,
      onDocumentLocalContentChange,
      reportDraftStorageError,
      reviewHandoffState,
    ],
  );

  const clearConfirmedDraft = useCallback(
    (draft: StoredDraft) => {
      if (draftRecordRef.current?.revision === draft.revision) {
        draftRecordRef.current = null;
        setDraftContentOverride(null);
        setDraftRecoveryState({ kind: "none" });
        const storage = draftStorageRef.current;
        const storageKey = draftStorageKeyRef.current;
        try {
          setOtherTabDraftPending(
            storage && storageKey
              ? storage
                  .list(storageKey)
                  .some((candidate) => candidate.tabId !== draft.tabId)
              : false,
          );
        } catch (error) {
          reportDraftStorageError(error);
        }
      }
    },
    [reportDraftStorageError],
  );

  const handleSaveDocumentWithDraft = useCallback(
    async (id: string, content: string) => {
      const storage = draftStorageRef.current;
      const storageKey = draftStorageKeyRef.current;
      const clientAtSaveStart = serverClientRef.current;
      let copiesAtSaveStart: StoredDraft[] = [];
      let draftAtSaveStart: StoredDraft | null = draftRecordRef.current;
      let localDraftAtSaveStart: StoredDraft | null = null;

      if (storage && storageKey) {
        try {
          localDraftAtSaveStart = storage.read(
            storageKey,
            draftTabIdRef.current ?? undefined,
          );
          if (draftAtSaveStart?.content !== content)
            draftAtSaveStart = localDraftAtSaveStart;
          copiesAtSaveStart = storage
            .list(storageKey)
            .filter((copy) => copy.content === content);
        } catch (error) {
          reportDraftStorageError(error);
        }
      }

      const serverCopiesAtSaveStart: StoredDraft[] =
        serverDraftsRef.current.filter((copy) => copy.content === content);
      const adoptedSource = adoptedSourceRef.current;
      if (adoptedSource) serverCopiesAtSaveStart.push(adoptedSource);

      const savedPage = await onSaveDocument(id, content);

      // Rebase the still-pending edition on exactly the bytes acknowledged
      // by this save. Its text and comments may be newer than that request.
      if (draftStorageKeyRef.current === storageKey) {
        const base = { content, version: savedPage?.version ?? null };
        draftBaseRef.current = base;
        const pending = draftRecordRef.current;
        if (storage && pending && pending.content !== content) {
          const rebased = createDraftRecord({
            storageKey: pending.storageKey,
            content: pending.content,
            base,
            revision: getDraftRevision(pending.tabId),
            tabId: pending.tabId,
          });
          storage.write(rebased);
          draftRecordRef.current = rebased;
          mirrorDraft(rebased);
        }
      }

      if (!storage || !storageKey || !draftAtSaveStart) return;
      if (draftAtSaveStart.content !== content) return;
      removeServerDraft(draftAtSaveStart, clientAtSaveStart);
      for (const copy of serverCopiesAtSaveStart)
        removeServerDraft(copy, clientAtSaveStart);
      if (adoptedSourceRef.current === adoptedSource)
        adoptedSourceRef.current = null;

      try {
        const removed =
          !localDraftAtSaveStart ||
          storage.removeIfRevision(
            storageKey,
            localDraftAtSaveStart.revision,
            localDraftAtSaveStart.tabId,
          );
        if (removed) {
          for (const copy of copiesAtSaveStart) {
            if (copy.content === content) {
              storage.removeIfRevision(storageKey, copy.revision, copy.tabId);
            }
          }
          clearConfirmedDraft(draftAtSaveStart);
          setDraftStorageError(null);
        } else {
          setOtherTabDraftPending(
            storage
              .list(storageKey)
              .some((draft) => draft.tabId !== draftTabIdRef.current),
          );
        }
      } catch (error) {
        reportDraftStorageError(error);
        throw error;
      }
    },
    [
      clearConfirmedDraft,
      mirrorDraft,
      onSaveDocument,
      removeServerDraft,
      reportDraftStorageError,
    ],
  );

  const handleDiscardDraft = useCallback(() => {
    const storage = draftStorageRef.current;
    const storageKey = draftStorageKeyRef.current;
    const draft = draftRecordRef.current;
    if (!storage || !storageKey || !draft) return;

    try {
      if (storage.removeIfRevision(storageKey, draft.revision, draft.tabId)) {
        removeServerDraft(draft);
        if (adoptedSourceRef.current) {
          removeServerDraft(adoptedSourceRef.current);
          storage.removeIfRevision(
            storageKey,
            adoptedSourceRef.current.revision,
            adoptedSourceRef.current.tabId,
          );
          adoptedSourceRef.current = null;
        }
        clearConfirmedDraft(draft);
        setDraftStorageError(null);
      } else {
        setOtherTabDraftPending(true);
      }
    } catch (error) {
      reportDraftStorageError(error);
    }
  }, [clearConfirmedDraft, removeServerDraft, reportDraftStorageError]);

  const handleRecoverChangedDraft = useCallback(() => {
    if (draftRecoveryState.kind !== "disk-changed") return;

    setDraftContentOverride(draftRecoveryState.draft.content);
    setDraftRecoveryState({
      kind: "disk-changed",
      draft: draftRecoveryState.draft,
      decision: "local",
    });
    latestLocalContentRef.current = draftRecoveryState.draft.content;
    onDocumentLocalContentChange(draftRecoveryState.draft.content);
    onDocumentDirtyStateChange(true);
    onDocumentSaveStateChange("unsaved");
  }, [
    draftRecoveryState,
    onDocumentDirtyStateChange,
    onDocumentLocalContentChange,
    onDocumentSaveStateChange,
  ]);

  const handleRecoverOtherDraft = useCallback(async () => {
    const storage = draftStorageRef.current;
    const storageKey = draftStorageKeyRef.current;
    const tabId = draftTabIdRef.current;
    if (
      !storage ||
      !storageKey ||
      !tabId ||
      !documentPage ||
      draftRecordRef.current
    )
      return;
    try {
      const client = serverClientRef.current;
      // Re-read server candidates on explicit recovery; never restore a stale GET snapshot.
      let remoteCandidates: ServerDraft[] = [];
      try {
        remoteCandidates = client ? await client.list() : [];
      } catch {
        setServerDraftError(
          "Could not recover the server draft. Browser draft recovery is still available.",
        );
      }
      if (
        serverClientRef.current !== client ||
        draftStorageKeyRef.current !== storageKey ||
        draftRecordRef.current
      )
        return;
      updateServerDrafts(remoteCandidates);
      const localCandidates = storage
        .list(storageKey)
        .filter(
          (draft) =>
            draft.tabId !== tabId && draft.content !== documentPage.content,
        );
      const candidates = [
        ...localCandidates,
        ...remoteCandidates.filter(
          (remote) =>
            remote.content !== documentPage.content &&
            !localCandidates.some(
              (local) =>
                local.tabId === remote.tabId &&
                local.revision === remote.revision,
            ),
        ),
      ];
      const saved = candidates
        .sort((left, right) => left.updatedAt - right.updatedAt)
        .at(-1);
      if (!saved) return;
      const fromServer = remoteCandidates.some(
        (remote) =>
          remote.tabId === saved.tabId && remote.revision === saved.revision,
      );
      adoptedSourceRef.current = saved;
      setRecoveredFromServer(fromServer);
      const adopted = createDraftRecord({
        storageKey,
        content: saved.content,
        base: { content: saved.baseContent, version: saved.baseVersion },
        tabId,
        revision: getDraftRevision(tabId),
      });
      storage.write(adopted);
      draftRecordRef.current = adopted;
      mirrorDraft(adopted);
      const recovery = inspectDraftRecovery(
        adopted,
        pageSnapshot(documentPage),
      );
      if (recovery.kind === "disk-changed") {
        setDraftRecoveryState({ ...recovery, decision: "pending" });
      } else {
        setDraftRecoveryState({ kind: "safe", draft: adopted });
        setDraftContentOverride(adopted.content);
        latestLocalContentRef.current = adopted.content;
        onDocumentLocalContentChange(adopted.content);
        onDocumentDirtyStateChange(true);
        onDocumentSaveStateChange("unsaved");
      }
    } catch (error) {
      if (error instanceof DraftStorageError) reportDraftStorageError(error);
      else
        setServerDraftError(
          "Could not recover the server draft. Your current document is unchanged.",
        );
    }
  }, [
    documentPage,
    mirrorDraft,
    updateServerDrafts,
    onDocumentLocalContentChange,
    onDocumentDirtyStateChange,
    onDocumentSaveStateChange,
    reportDraftStorageError,
  ]);

  const handleReloadAndDiscardDraft = useCallback(async () => {
    const draft = draftRecordRef.current;
    const storage = draftStorageRef.current;
    if (draft && storage) {
      const client = serverClientRef.current;
      // A discarded edition must survive the choice and a browser restart.
      // Server deletion archives the complete draft before removing it.
      const saved = client ? await client.put(draft) : null;
      if (saved && client) await client.remove(draft);
      else {
        const recoveryTab = `recovery-${getDraftRevision(draft.tabId)}`;
        storage.write({
          ...draft,
          tabId: recoveryTab,
          revision: getDraftRevision(recoveryTab),
        });
      }
      if (draftRecordRef.current?.revision !== draft.revision)
        throw new Error(
          "Your edits changed while saving the recovery copy. Choose again to keep the latest edits safe.",
        );
    }
    await onReloadDocumentFromDisk();
    handleDiscardDraft();
  }, [handleDiscardDraft, onReloadDocumentFromDisk]);

  const runDraftAction = async (action: () => void | Promise<void>) => {
    if (draftActionPending) return;
    setDraftActionPending(true);
    setDraftActionError(null);
    try {
      await action();
    } catch (error) {
      setDraftActionError(
        error instanceof Error
          ? error.message
          : "Could not save both copies. Your edits are still open.",
      );
    } finally {
      setDraftActionPending(false);
    }
  };

  const handleOverwriteDocumentWithDraft = useCallback(async () => {
    // Capture the exact persisted revision that the explicit overwrite is
    // confirming.  The editor can normalize content while the save is in
    // flight; revision matching is the durable ownership check and also
    // protects a newer draft written by another tab.
    const storage = draftStorageRef.current;
    const storageKey = draftStorageKeyRef.current;
    const draftAtOverwriteStart = draftRecordRef.current;
    const clientAtOverwriteStart = serverClientRef.current;
    const copiesAtOverwriteStart =
      storage && storageKey
        ? storage
            .list(storageKey)
            .filter((copy) => copy.content === draftAtOverwriteStart?.content)
        : [];
    const serverCopiesAtOverwriteStart: StoredDraft[] =
      serverDraftsRef.current.filter(
        (copy) => copy.content === draftAtOverwriteStart?.content,
      );
    const adoptedSource = adoptedSourceRef.current;
    if (adoptedSource) serverCopiesAtOverwriteStart.push(adoptedSource);

    await onOverwriteDocumentOnDisk();

    if (!storage || !storageKey || !draftAtOverwriteStart) return;
    removeServerDraft(draftAtOverwriteStart, clientAtOverwriteStart);
    for (const copy of serverCopiesAtOverwriteStart)
      removeServerDraft(copy, clientAtOverwriteStart);
    if (adoptedSourceRef.current === adoptedSource)
      adoptedSourceRef.current = null;

    try {
      const removed = storage.removeIfRevision(
        storageKey,
        draftAtOverwriteStart.revision,
        draftAtOverwriteStart.tabId,
      );
      if (removed) {
        for (const copy of copiesAtOverwriteStart) {
          if (copy.content === draftAtOverwriteStart.content) {
            storage.removeIfRevision(storageKey, copy.revision, copy.tabId);
          }
        }
        clearConfirmedDraft(draftAtOverwriteStart);
        setDraftStorageError(null);
      } else {
        setOtherTabDraftPending(true);
      }
    } catch (error) {
      reportDraftStorageError(error);
    }
  }, [
    clearConfirmedDraft,
    onOverwriteDocumentOnDisk,
    removeServerDraft,
    reportDraftStorageError,
  ]);

  const [documentHasComments, setDocumentHasComments] = useState(
    () =>
      !!documentPage?.content &&
      criticMarkdownHasReviewRail(documentPage.content),
  );
  const [restoringRevision, setRestoringRevision] = useState(false);
  const documentDirtyRef = useRef(false);
  const outline = useDocumentOutlineNavigation({
    headings: outlineHeadings,
    editor: revisionEditor,
    sourceNavigation: codeNavigation,
    sourceMode: documentEditorViewMode === "code",
    workspace: workspaceElement,
  });

  useEffect(() => {
    setDocumentHasComments(
      !!documentPage?.content &&
        criticMarkdownHasReviewRail(documentPage.content),
    );
  }, [documentPage?.content]);

  useEffect(() => {
    const documentIdentity = `${activeDocumentPath ?? ""}:${documentPage?.id ?? ""}`;
    if (reviewHandoffDocumentIdentityRef.current !== documentIdentity) {
      reviewHandoffDocumentIdentityRef.current = documentIdentity;
      documentChangeTrackingReadyRef.current = false;
      // Restore completion once on opening. Later save responses must not
      // reset the ongoing review or overwrite a new local edit's state.
      setReviewHandoffState(
        documentPage?.reviewState === "completed" ? "completed" : "idle",
      );
      setReviewHandoffPopoverOpen(false);
      setDocumentChangedSinceOpen(false);
      setAutosaveDeadline(null);
    }
    const readyTimer = window.setTimeout(() => {
      documentChangeTrackingReadyRef.current = true;
    }, 0);
    return () => window.clearTimeout(readyTimer);
  }, [activeDocumentPath, documentPage?.id, documentPage?.reviewState]);

  useEffect(() => {
    if (previousReviewOpenRequestKeyRef.current === reviewOpenRequestKey)
      return;
    previousReviewOpenRequestKeyRef.current = reviewOpenRequestKey;
    // The CLI can reuse this exact URL for the agent's next iteration.
    // Reset the completed handoff without reloading or discarding local work.
    setReviewHandoffState((current) =>
      current === "notified" ||
      current === "undelivered" ||
      current === "completed"
        ? "idle"
        : current,
    );
    setReviewHandoffPopoverOpen(false);
    setDocumentChangedSinceOpen(false);
  }, [reviewOpenRequestKey]);

  useEffect(() => {
    if (!backend?.getReviewWatchStatus || !activeDocumentPath) {
      setReviewWatcherCount(0);
      return;
    }

    let cancelled = false;
    const refreshWatchStatus = async () => {
      try {
        const status = await backend.getReviewWatchStatus?.(activeDocumentPath);
        if (!cancelled) {
          setReviewWatcherCount(status?.watcherCount ?? 0);
        }
      } catch {
        if (!cancelled) {
          setReviewWatcherCount(0);
        }
      }
    };

    void refreshWatchStatus();
    const interval = window.setInterval(refreshWatchStatus, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeDocumentPath, backend]);

  useEffect(() => {
    if (reviewHandoffState !== "notified") {
      sawNoWatcherAfterNotifiedRef.current = false;
      return;
    }

    if (reviewWatcherCount === 0) {
      sawNoWatcherAfterNotifiedRef.current = true;
      return;
    }

    if (sawNoWatcherAfterNotifiedRef.current) {
      sawNoWatcherAfterNotifiedRef.current = false;
      setReviewHandoffState("idle");
    }
  }, [reviewHandoffState, reviewWatcherCount]);

  useEffect(() => {
    if (reviewHandoffState === "notified") {
      setReviewCompleteTitle((currentTitle) =>
        getRandomReviewCompleteTitleExcept(currentTitle),
      );
    }
  }, [reviewHandoffState]);

  useEffect(() => {
    return () => {
      if (copiedFileActionTimeoutRef.current !== null) {
        window.clearTimeout(copiedFileActionTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!documentPage) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const isSaveShortcut =
        event.key.toLowerCase() === "s" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey;

      if (!isSaveShortcut) return;

      event.preventDefault();
      event.stopPropagation();

      if (documentDiskChangeState !== "clean") return;

      void saveControllerRef.current?.flushSave();
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [documentDiskChangeState, documentPage]);

  useEffect(() => {
    if (!documentPage) return;

    const handleOnline = () => {
      void saveControllerRef.current?.retrySave();
    };

    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [documentPage]);

  const handleCompleteReview = useCallback(
    async (options?: CompleteReviewOptions) => {
      if (!activeDocumentPath || reviewHandoffState === "notifying") return;

      setReviewHandoffState("notifying");
      try {
        // The button stays enabled while autosave is still pending, so make
        // sure any debounced edits are persisted before handing off.
        const flushResult = await saveControllerRef.current?.flushSave();
        if (flushResult && flushResult.status === "error") {
          throw flushResult.error;
        }
        if (flushResult?.status === "blocked") {
          throw new Error(
            "Resolve the save conflict before finishing this iteration.",
          );
        }

        // Finish queued recovery writes/removals before closing the iteration;
        // a late draft acknowledgement must not put this review back in editing.
        await serverClientRef.current?.list();

        const result = await onCompleteReview(options);
        if (result.delivered) {
          setReviewWatcherCount(0);
          setReviewHandoffState("notified");
          setOverallComment("");
          setReviewHandoffPopoverOpen(true);
        } else {
          setReviewWatcherCount(0);
          setReviewHandoffState("undelivered");
          setOverallComment("");
          setReviewHandoffPopoverOpen(true);
        }
      } catch (error) {
        console.error("Failed to complete review:", error);
        setReviewHandoffState("error");
        setReviewHandoffPopoverOpen(true);
      }
    },
    [activeDocumentPath, onCompleteReview, reviewHandoffState],
  );

  const handleDocumentDirtyStateChange = useCallback(
    (isDirty: boolean) => {
      documentDirtyRef.current = isDirty;
      if (
        shouldLatchDocumentChangedSinceOpen({
          isDirty,
          documentChangeTrackingReady: documentChangeTrackingReadyRef.current,
        })
      ) {
        setDocumentChangedSinceOpen(true);
      }
      onDocumentDirtyStateChange(isDirty);
    },
    [onDocumentDirtyStateChange],
  );

  const handleCopyFileMenuAction = useCallback(
    async (action: FileCopyAction) => {
      if (!documentPage) return;

      const copyTextByAction: Record<
        Exclude<FileCopyAction, "rich-text">,
        string
      > = {
        path: documentCopyPath ?? activeDocumentPath ?? documentFilenameLabel,
        filename: documentFilenameLabel,
        markdown: documentPage.content,
      };

      try {
        if (action === "rich-text") {
          await writeRichTextToClipboard(documentPage.content);
        } else {
          await writePlainTextToClipboard(copyTextByAction[action]);
        }

        setCopiedFileAction(action);
        if (copiedFileActionTimeoutRef.current !== null) {
          window.clearTimeout(copiedFileActionTimeoutRef.current);
        }
        copiedFileActionTimeoutRef.current = window.setTimeout(() => {
          setCopiedFileAction(null);
          copiedFileActionTimeoutRef.current = null;
        }, 3000);
      } catch (error) {
        console.error("Failed to copy document data:", error);
      }
    },
    [activeDocumentPath, documentCopyPath, documentFilenameLabel, documentPage],
  );

  const editorViewModeToggleLabel =
    documentEditorViewMode === "rich-text"
      ? "Switch to code view"
      : "Switch to rich text view";
  const fileCopyPreviewByAction: Record<FileCopyAction, string> = {
    path: formatFileCopyPreview(
      documentCopyPath ?? activeDocumentPath ?? documentFilenameLabel,
    ),
    filename: formatFileCopyPreview(documentFilenameLabel),
    markdown: formatFileCopyPreview(documentPage?.content ?? ""),
    "rich-text": formatFileCopyPreview(
      documentPage ? markdownToPlainText(documentPage.content) : "",
    ),
  };
  const activeDocumentInteractionMode = documentInteractionModeOptions.find(
    (option) => option.value === documentInteractionMode,
  );
  const ActiveDocumentInteractionModeIcon =
    activeDocumentInteractionMode?.Icon ?? PencilLine;
  const draftIsSafeRecovered = draftRecoveryState.kind === "safe";
  const draftHasDiskConflict = draftRecoveryState.kind === "disk-changed";
  const draftHasLocalRecovery =
    draftHasDiskConflict && draftRecoveryState.decision === "local";
  const draftBlocksSave = draftHasDiskConflict;
  const effectiveDiskChangeState =
    documentDiskChangeState !== "clean"
      ? documentDiskChangeState
      : draftBlocksSave
        ? "conflict"
        : "clean";
  const serverDraftPending = serverDrafts.some(
    (draft) =>
      draft.content !== documentPage?.content &&
      (draft.tabId !== draftTabIdRef.current ||
        !ownedDraftRevisionsRef.current.has(draft.revision)),
  );
  const anyOtherDraftPending = otherTabDraftPending || serverDraftPending;
  const effectiveSaveState = draftStorageError ? "error" : saveState;
  const hasUnsavedEdition =
    effectiveSaveState !== "saved" || effectiveDiskChangeState !== "clean";
  const saveDetail =
    hasUnsavedEdition &&
    (effectiveSaveState === "error" || effectiveDiskChangeState !== "clean")
      ? draftStorageError
        ? "Not saved. Keep this page open."
        : draftRecordRef.current
          ? mirroredDraftRevision === draftRecordRef.current.revision
            ? "Document not saved; server recovery copy available."
            : "Browser copy only; the agent cannot see these edits."
          : "File changed elsewhere. Choose which text to keep."
      : backend?.info.kind === "remote" && !hasUnsavedEdition
        ? "Source file save confirmation is unavailable."
        : undefined;
  const draftRecoveryNoticeVisible =
    draftIsSafeRecovered || draftHasDiskConflict;
  const hasTopNotice =
    documentDiskChangeState !== "clean" ||
    draftRecoveryNoticeVisible ||
    anyOtherDraftPending ||
    !!serverDraftError ||
    !!draftStorageError;
  const documentPageForEditor =
    documentPage && draftContentOverride !== null
      ? { ...documentPage, content: draftContentOverride }
      : documentPage;
  const conflictNotice =
    documentDiskChangeState === "clean"
      ? null
      : conflictNoticeCopy[documentDiskChangeState];
  const showReviewHandoffButton =
    !!activeDocumentPath &&
    (backend?.info.kind === "local-files" ||
      reviewWatcherCount > 0 ||
      reviewHandoffState !== "idle");
  const reviewHandoffFinished =
    reviewHandoffState === "notified" ||
    reviewHandoffState === "undelivered" ||
    reviewHandoffState === "completed";
  const reviewHandoffButtonLabel = getReviewHandoffButtonLabel({
    reviewHandoffState,
    documentChangedSinceOpen,
  });
  const ReviewHandoffButtonIcon =
    reviewHandoffState === "notifying"
      ? Loader2
      : reviewHandoffState === "error"
        ? AlertTriangle
        : reviewHandoffState === "undelivered" ||
            reviewHandoffState === "completed"
          ? Check
          : null;
  const reviewHandoffStatusTitle =
    reviewHandoffState === "completed"
      ? "Review completed"
      : reviewHandoffState === "undelivered"
        ? "Not sent, but saved"
        : reviewHandoffState === "error"
          ? "Could not notify agent"
          : reviewCompleteTitle;
  const reviewHandoffStatusBody =
    reviewHandoffState === "completed"
      ? "This review is saved on the local server. The agent can read the document and its review history. Editing the document starts another review."
      : reviewHandoffState === "undelivered"
        ? "Your comments and review are saved. No agent is waiting right now. Continue the original session when you’re ready; the agent can read this document and its review history."
        : reviewHandoffState === "error"
          ? "Roughdraft could not confirm the handoff. Check that the local server is running, then click Not sent to try again."
          : null;
  const reviewHandoffCopyMessage = buildReviewHandoffCopyMessage(
    activeDocumentPath ?? documentFilenameLabel,
  );
  const reviewHandoffDisabled = isReviewHandoffDisabled({
    saveState: effectiveSaveState,
    documentDiskChangeState: effectiveDiskChangeState,
    reviewHandoffState,
  });
  const reviewHandoffButtonDisabled =
    restoringRevision ||
    draftActionPending ||
    (reviewHandoffDisabled &&
      !reviewHandoffFinished &&
      !(
        reviewHandoffState === "error" && effectiveDiskChangeState === "clean"
      ));
  const restoreDisabledReason = restoringRevision
    ? "Restoring version…"
    : reviewHandoffState === "notifying" || draftActionPending
      ? "Wait for the current save to finish."
      : effectiveDiskChangeState !== "clean"
        ? "Resolve the file conflict before restoring a version."
        : effectiveSaveState !== "saved" || draftRecordRef.current
          ? "Save your current edits before restoring a version."
          : undefined;

  const handleRestoreRevision = async (content: string) => {
    if (!documentPage) throw new Error("No document is open.");
    if (restoreDisabledReason || documentDirtyRef.current)
      throw new Error(
        restoreDisabledReason ??
          "Save your current edits before restoring a version.",
      );
    setRestoringRevision(true);
    try {
      await handleSaveDocumentWithDraft(documentPage.id, content);
      await onReloadDocumentFromDisk();
    } finally {
      setRestoringRevision(false);
    }
  };

  const trimmedOverallComment = overallComment.trim();
  const embedded =
    new URLSearchParams(window.location.search).get("embed") === "1";

  return (
    <div
      className="document-workspace-shell min-h-0 flex-1"
      data-testid="document-workspace-shell"
      data-document-embed={embedded ? "true" : undefined}
    >
      {documentPage ? (
        <DocumentOutline
          key={`${documentPage.id}:${activeDocumentPath ?? ""}`}
          headings={outlineHeadings}
          activeId={outline.activeId}
          disabled={reviewHandoffState === "notifying" || draftActionPending}
          onNavigate={outline.navigate}
        />
      ) : null}
      <div
        ref={setWorkspaceElement}
        data-testid="document-workspace"
        data-document-scroll-container="true"
        data-document-embed={embedded ? "true" : undefined}
        data-document-has-comments={documentHasComments ? "true" : "false"}
        className={cn(
          "document-workspace min-h-0 overflow-y-auto pb-8",
          hasTopNotice ? "pt-64 sm:pt-44" : "pt-3",
        )}
      >
        <RemoteSessionBanner backend={backend} />
        {draftActionError ? (
          <div
            data-testid="draft-action-error"
            role="alert"
            className="fixed top-12 left-1/2 z-[75] w-[min(calc(100vw-1rem),52rem)] -translate-x-1/2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-950"
          >
            {draftActionError}
          </div>
        ) : null}
        {anyOtherDraftPending &&
        !draftRecoveryNoticeVisible &&
        !draftStorageError ? (
          <div
            data-testid="draft-other-notice"
            role="status"
            className="fixed top-24 left-1/2 z-[65] flex w-[min(calc(100vw-1rem),52rem)] -translate-x-1/2 flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-300 bg-sky-50 p-4 text-sky-950 shadow-lg dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100"
          >
            <p className="text-sm">
              {serverDraftPending
                ? "A server draft is available from another browser or tab."
                : "This browser has an unsaved draft from another tab."}{" "}
              Save your current edits before recovering it.
            </p>
            <Button
              data-testid="draft-recovery-other"
              type="button"
              size="sm"
              disabled={!!draftRecordRef.current || saveState === "saving"}
              onClick={handleRecoverOtherDraft}
            >
              {serverDraftPending
                ? "Recover server draft"
                : "Recover saved browser draft"}
            </Button>
          </div>
        ) : null}
        {serverDraftError && !draftStorageError ? (
          <div
            data-testid="server-draft-error"
            role="alert"
            className="relative z-[70] mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
          >
            {serverDraftError}
          </div>
        ) : null}
        {draftStorageError ? (
          <div
            data-testid="draft-storage-error"
            role="alert"
            className="fixed top-24 left-1/2 z-[70] flex w-[min(calc(100vw-1rem),52rem)] -translate-x-1/2 items-start gap-2.5 rounded-[8px] border border-red-300 bg-red-50 px-3 py-3 text-red-950 shadow-[0_14px_40px_rgba(127,29,29,0.18)] dark:border-red-800 dark:bg-red-950 dark:text-red-100"
          >
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <div className="text-sm font-semibold">
                Draft recovery unavailable
              </div>
              <div className="mt-0.5 text-xs leading-5">
                {draftStorageError.message} Roughdraft will keep showing the
                current edits, but it cannot report them as durably saved.
              </div>
            </div>
          </div>
        ) : null}
        {draftRecoveryNoticeVisible && draftRecoveryState.kind === "safe" ? (
          <div
            data-testid="draft-recovery-notice"
            role="status"
            aria-label={
              recoveredFromServer
                ? "Recovered server draft"
                : "Recovered local draft"
            }
            className="fixed top-24 left-1/2 z-[65] flex w-[min(calc(100vw-1rem),52rem)] -translate-x-1/2 flex-col gap-3 rounded-[8px] border border-sky-300 bg-sky-50 px-3 py-3 text-sky-950 shadow-[0_14px_40px_rgba(14,116,144,0.18)] dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100 sm:flex-row sm:items-center sm:justify-between sm:px-4"
          >
            <div className="flex min-w-0 items-start gap-2.5">
              <RefreshCcw
                className="mt-0.5 size-4 shrink-0 text-sky-700 dark:text-sky-300"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <div className="text-sm font-semibold">
                  {recoveredFromServer
                    ? "Recovered server draft"
                    : "Recovered local draft"}
                </div>
                <div className="mt-0.5 text-xs leading-5 text-sky-900 dark:text-sky-200">
                  Your edits were recovered after the last save failed. The
                  document is unsaved until Roughdraft confirms a new save.
                </div>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end">
              <Button
                type="button"
                data-testid="draft-recovery-save"
                size="sm"
                className="h-8 rounded-[7px] bg-sky-900 px-2 text-xs text-white hover:bg-sky-800 dark:bg-sky-600 dark:hover:bg-sky-500"
                onClick={() => void saveControllerRef.current?.flushSave()}
              >
                <Check className="size-3.5" />
                Save recovered draft
              </Button>
              <Button
                type="button"
                data-testid="draft-recovery-discard"
                variant="ghost"
                size="sm"
                className="h-8 rounded-[7px] bg-white/55 px-2 text-xs text-sky-950 hover:bg-white dark:bg-white/10 dark:text-sky-100 dark:hover:bg-white/20"
                disabled={draftActionPending}
                onClick={() => void runDraftAction(handleReloadAndDiscardDraft)}
              >
                Use saved document
              </Button>
            </div>
          </div>
        ) : null}
        {draftRecoveryNoticeVisible &&
        draftRecoveryState.kind === "disk-changed" ? (
          <div
            data-testid="draft-recovery-notice"
            role="status"
            aria-label="Local draft needs recovery"
            className="fixed top-24 left-1/2 z-[65] flex w-[min(calc(100vw-1rem),52rem)] -translate-x-1/2 flex-col gap-3 rounded-[8px] border border-amber-300 bg-amber-50 px-3 py-3 text-amber-950 shadow-[0_14px_40px_rgba(120,53,15,0.18)] dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100 sm:flex-row sm:items-center sm:justify-between sm:px-4"
          >
            <div className="flex min-w-0 items-start gap-2.5">
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <div className="text-sm font-semibold">
                  File changed while you were editing
                </div>
                <div className="mt-0.5 text-xs leading-5 text-amber-900 dark:text-amber-200">
                  Preview your edits, then choose which text to continue with.
                  The other copy stays available in History → Recovery points.
                </div>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end">
              <Button
                type="button"
                data-testid="draft-recovery-keep-disk"
                variant="ghost"
                size="sm"
                className="h-8 rounded-[7px] bg-white/55 px-2 text-xs text-amber-950 hover:bg-white dark:bg-white/10 dark:text-amber-100 dark:hover:bg-white/20"
                disabled={draftActionPending}
                onClick={() => void runDraftAction(handleReloadAndDiscardDraft)}
              >
                Use file from disk
              </Button>
              {draftHasLocalRecovery ? (
                <Button
                  type="button"
                  data-testid="draft-recovery-overwrite"
                  size="sm"
                  className="h-8 rounded-[7px] bg-amber-900 px-2 text-xs text-white hover:bg-amber-800 dark:bg-amber-600 dark:hover:bg-amber-500"
                  disabled={draftActionPending}
                  onClick={() =>
                    void runDraftAction(handleOverwriteDocumentWithDraft)
                  }
                >
                  <Upload className="size-3.5" />
                  Use my edits
                </Button>
              ) : (
                <Button
                  type="button"
                  data-testid="draft-recovery-recover-local"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-[7px] bg-white/55 px-2 text-xs text-amber-950 hover:bg-white dark:bg-white/10 dark:text-amber-100 dark:hover:bg-white/20"
                  disabled={draftActionPending}
                  onClick={handleRecoverChangedDraft}
                >
                  <RefreshCcw className="size-3.5" />
                  Preview my edits
                </Button>
              )}
            </div>
          </div>
        ) : null}
        {documentPage ? (
          <div
            className="fixed top-3 left-3 z-[60]"
            data-testid="document-save-status-corner"
          >
            <DocumentSaveStatusIndicator
              saveState={effectiveSaveState}
              diskChangeState={effectiveDiskChangeState}
              autosaveDeadline={autosaveDeadline}
              detail={saveDetail}
              savedLabel={
                backend?.info.kind === "remote"
                  ? "Sent to remote session"
                  : backend?.info.kind === "local-storage"
                    ? "Saved in this browser"
                    : undefined
              }
            />
          </div>
        ) : null}
        <div
          className={cn(
            "fixed right-3 z-[60] flex max-w-[min(16rem,calc(100vw-1rem))] flex-col items-end gap-1.5",
            "top-3",
          )}
          data-testid="document-status-stack"
          data-document-status-stack="true"
        >
          <div className="flex max-w-full items-center justify-end gap-1.5">
            {showReviewHandoffButton ? (
              <Popover
                open={reviewHandoffPopoverOpen}
                onOpenChange={(open) => {
                  if (!overallCommentUploading)
                    setReviewHandoffPopoverOpen(open);
                }}
              >
                <div
                  data-testid="review-handoff-split-button"
                  className={cn(
                    "relative flex items-center overflow-hidden rounded-[7px] shadow-[0_10px_28px_rgba(0,0,0,0.18)] transition-opacity after:pointer-events-none after:absolute after:top-px after:right-8 after:bottom-px after:z-10 after:w-px after:bg-[#4a4038] after:content-[''] dark:after:bg-slate-600",
                    reviewHandoffDisabled &&
                      reviewHandoffState !== "undelivered" &&
                      reviewHandoffState !== "error" &&
                      "opacity-50",
                  )}
                >
                  <Button
                    type="button"
                    data-testid="review-handoff-button"
                    size="lg"
                    className="h-9 rounded-r-none rounded-l-[7px] border-0 bg-[#2B2420] px-3 text-sm font-bold text-white hover:bg-[#3a322b] focus-visible:ring-slate-300 disabled:opacity-100 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600 dark:focus-visible:ring-slate-600"
                    disabled={
                      reviewHandoffButtonDisabled || overallCommentUploading
                    }
                    aria-disabled={reviewHandoffButtonDisabled || undefined}
                    onClick={() => {
                      if (reviewHandoffFinished) {
                        setReviewHandoffPopoverOpen(true);
                        return;
                      }

                      void handleCompleteReview(
                        trimmedOverallComment
                          ? { overallComment: trimmedOverallComment }
                          : undefined,
                      );
                    }}
                  >
                    {ReviewHandoffButtonIcon ? (
                      <ReviewHandoffButtonIcon
                        className={cn(
                          "size-4",
                          reviewHandoffState === "notifying" && "animate-spin",
                        )}
                      />
                    ) : null}
                    {reviewHandoffButtonLabel}
                  </Button>
                  <PopoverTrigger
                    render={
                      <Button
                        type="button"
                        data-testid="review-handoff-comment-trigger"
                        size="icon-lg"
                        className="h-9 w-8 rounded-l-none rounded-r-[7px] border-0 bg-[#2B2420] text-white hover:bg-[#3a322b] focus-visible:ring-slate-300 disabled:opacity-100 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600 dark:focus-visible:ring-slate-600"
                        disabled={reviewHandoffDisabled}
                        aria-label="Add overall handoff comment"
                      >
                        <ChevronDown className="size-4" />
                      </Button>
                    }
                  />
                </div>
                <PopoverContent
                  className={
                    reviewHandoffState === "notified" ? "pt-0" : undefined
                  }
                  aria-label={
                    reviewHandoffState === "idle"
                      ? "Review handoff comment"
                      : "Review handoff status"
                  }
                  data-testid={
                    reviewHandoffState === "idle"
                      ? "review-handoff-comment-popover"
                      : "review-handoff-status"
                  }
                >
                  {reviewHandoffState === "idle" ? (
                    <form
                      className="space-y-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (overallCommentUploading) return;
                        void handleCompleteReview({
                          overallComment: trimmedOverallComment,
                        });
                      }}
                    >
                      <div>
                        <CommentComposer
                          id="review-handoff-overall-comment"
                          data-testid="review-handoff-overall-comment"
                          aria-label="Overall comment"
                          placeholder="Overall comment"
                          value={overallComment}
                          backend={backend}
                          onUploadingChange={setOverallCommentUploading}
                          onChange={setOverallComment}
                          maxLength={4000}
                          rows={4}
                          className="min-h-24 resize-none"
                        />
                      </div>
                      <Button
                        type="submit"
                        data-testid="review-handoff-submit-comment"
                        size="lg"
                        className="w-full rounded-[7px] bg-black text-sm font-bold text-white hover:bg-black/85 focus-visible:ring-black/25 dark:bg-white dark:text-black dark:hover:bg-white/90"
                        disabled={
                          !trimmedOverallComment || overallCommentUploading
                        }
                      >
                        <CheckCheck className="size-4" />
                        Submit with comment
                      </Button>
                    </form>
                  ) : (
                    <div>
                      {reviewHandoffState === "notified" ? (
                        <div className="mb-3 flex h-[170px] items-center justify-center overflow-hidden">
                          <RobotsHighFiveToy
                            onHighFive={() =>
                              setReviewCompleteTitle((currentTitle) =>
                                getRandomReviewCompleteTitleExcept(
                                  currentTitle,
                                ),
                              )
                            }
                          />
                        </div>
                      ) : null}
                      <div className="flex items-start gap-3">
                        {reviewHandoffState === "notifying" ||
                        reviewHandoffState === "error" ? (
                          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-black text-white dark:bg-white dark:text-black">
                            {reviewHandoffState === "notifying" ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <AlertTriangle className="size-4" />
                            )}
                          </span>
                        ) : null}
                        <div>
                          <div className="text-xl font-semibold leading-6 text-stone-950 dark:text-slate-50">
                            {reviewHandoffStatusTitle}
                          </div>
                          {reviewHandoffStatusBody ? (
                            <p className="mt-1 text-sm leading-6 text-stone-600 dark:text-slate-300">
                              {reviewHandoffStatusBody}
                            </p>
                          ) : (
                            <div className="mt-1">
                              <p className="text-sm leading-[1.32rem] text-stone-500 dark:text-slate-400">
                                Your agent is now working in the background on
                                this, in all likelihood. If our signal didn't
                                make it, just{" "}
                                <button
                                  type="button"
                                  data-testid="review-handoff-copy-message"
                                  className="font-normal text-inherit underline decoration-stone-300 underline-offset-4 hover:decoration-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-950/25 dark:decoration-slate-600 dark:hover:decoration-slate-200 dark:focus-visible:ring-slate-50/30"
                                  onClick={() =>
                                    void writePlainTextToClipboard(
                                      reviewHandoffCopyMessage,
                                    )
                                  }
                                >
                                  click here
                                </button>{" "}
                                to copy a line you can send it to keep going.
                              </p>
                              <Button
                                type="button"
                                data-testid="review-handoff-close-window"
                                size="lg"
                                variant="outline"
                                className="mt-4 w-full rounded-[7px] text-sm font-semibold"
                                onClick={() => window.close()}
                              >
                                Close window
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            ) : null}
          </div>
        </div>
        {conflictNotice ? (
          <div
            data-testid="file-conflict-notice"
            role="status"
            aria-label="File conflict"
            className="fixed top-24 left-1/2 z-50 flex w-[min(calc(100vw-1rem),52rem)] -translate-x-1/2 flex-col gap-3 rounded-[8px] border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-3 py-3 text-amber-950 dark:text-amber-100 shadow-[0_14px_40px_rgba(120,53,15,0.18)] dark:shadow-[0_14px_40px_rgba(0,0,0,0.4)] sm:flex-row sm:items-center sm:justify-between sm:px-4"
          >
            <div className="flex min-w-0 items-start gap-2.5">
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <div className="text-sm font-semibold leading-5">
                  {conflictNotice.title}
                </div>
                <div className="mt-0.5 text-xs leading-5 text-amber-900 dark:text-amber-200">
                  {conflictNotice.body}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end">
              <Button
                type="button"
                data-testid="file-conflict-action-reload"
                variant="ghost"
                size="sm"
                className="h-8 rounded-[7px] bg-white/55 dark:bg-white/10 px-2 text-xs text-amber-950 dark:text-amber-100 hover:bg-white dark:hover:bg-white/20"
                disabled={draftActionPending}
                onClick={() => void runDraftAction(handleReloadAndDiscardDraft)}
              >
                <RefreshCcw className="size-3.5" />
                Use file from disk
              </Button>
              {documentDiskChangeState !== "paused" ? (
                <Button
                  type="button"
                  data-testid="file-conflict-action-keep-editing"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-[7px] bg-white/55 dark:bg-white/10 px-2 text-xs text-amber-950 dark:text-amber-100 hover:bg-white dark:hover:bg-white/20"
                  onClick={onKeepEditingWithoutAutosave}
                >
                  <PencilLine className="size-3.5" />
                  Decide later
                </Button>
              ) : null}
              <Button
                type="button"
                data-testid="file-conflict-action-overwrite"
                variant="ghost"
                size="sm"
                className="h-8 rounded-[7px] bg-amber-900 dark:bg-amber-600 px-2 text-xs text-white hover:bg-amber-800 dark:hover:bg-amber-500"
                disabled={draftActionPending}
                onClick={() =>
                  void runDraftAction(handleOverwriteDocumentWithDraft)
                }
              >
                <Upload className="size-3.5" />
                Use my edits
              </Button>
            </div>
          </div>
        ) : null}
        <div
          className="mx-auto min-h-full w-full"
          inert={reviewHandoffState === "notifying" || draftActionPending}
          aria-busy={
            reviewHandoffState === "notifying" ||
            draftActionPending ||
            undefined
          }
        >
          {documentPage ? (
            <div
              className="document-floating-rail"
              data-testid="document-floating-rail"
            >
              <div
                className="document-floating-tools"
                data-testid="document-floating-tools"
                role="group"
                aria-label="Document tools"
              >
                <div
                  data-testid="document-page-header"
                  className="document-tools-group"
                >
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          data-testid="document-editor-view-toggle"
                          className="document-tool-button"
                          aria-label={editorViewModeToggleLabel}
                          onClick={() =>
                            onDocumentEditorViewModeChange(
                              documentEditorViewMode === "rich-text"
                                ? "code"
                                : "rich-text",
                            )
                          }
                        >
                          {documentEditorViewMode === "rich-text" ? (
                            <CodeXml />
                          ) : (
                            <Eye />
                          )}
                        </Button>
                      }
                    />
                    <TooltipContent side="right">
                      {documentEditorViewMode === "rich-text"
                        ? "Switch to code view. Edit the Markdown source directly."
                        : "Switch to rich text view. Edit formatted text and see version highlights."}
                    </TooltipContent>
                  </Tooltip>
                  <Popover
                    open={fileCopyMenuOpen}
                    onOpenChange={setFileCopyMenuOpen}
                  >
                    <Tooltip open={fileCopyMenuOpen ? false : undefined}>
                      <TooltipTrigger
                        render={
                          <PopoverTrigger
                            render={
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                data-testid="document-file-menu-trigger"
                                className="document-tool-button"
                                aria-label="Document file actions"
                              >
                                <FileText aria-hidden="true" />
                                <span className="sr-only">
                                  {documentFilenameLabel}
                                </span>
                              </Button>
                            }
                          />
                        }
                      />
                      <TooltipContent side="right">
                        Copy the path, filename, Markdown, or rich text.
                      </TooltipContent>
                    </Tooltip>
                    <PopoverContent
                      aria-label="Document file actions"
                      data-testid="document-file-menu"
                      className="w-56 p-1"
                      align="start"
                      side="right"
                      sideOffset={12}
                    >
                      <div className="flex flex-col">
                        {fileCopyMenuOptions.map(({ action, label }) => (
                          <button
                            key={action}
                            type="button"
                            data-testid={`document-file-menu-${action}`}
                            className="flex items-start gap-2 rounded-md px-2 py-1.5 text-left text-[0.72rem] leading-none text-stone-700 outline-none transition hover:bg-[#EEE9E1] focus-visible:bg-[#EEE9E1] dark:text-stone-300 dark:hover:bg-slate-700 dark:focus-visible:bg-slate-700"
                            onClick={() =>
                              void handleCopyFileMenuAction(action)
                            }
                          >
                            <Copy
                              className="mt-[0.06rem] size-4 shrink-0 text-stone-500 dark:text-slate-400"
                              aria-hidden="true"
                            />
                            <span className="grid min-w-0 flex-1 gap-1">
                              <span className="truncate font-medium">
                                {copiedFileAction === action
                                  ? "Copied!"
                                  : label}
                              </span>
                              <span className="truncate text-[0.66rem] leading-none text-stone-400 dark:text-slate-500">
                                {fileCopyPreviewByAction[action]}
                              </span>
                            </span>
                            {copiedFileAction === action ? (
                              <Check className="mt-[0.06rem] ml-auto size-3 shrink-0 text-stone-500 dark:text-stone-400" />
                            ) : null}
                          </button>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                  <Select<DocumentInteractionMode>
                    value={documentInteractionMode}
                    onValueChange={(value) => {
                      if (value) setDocumentInteractionMode(value);
                    }}
                  >
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <SelectTrigger
                            data-testid="document-mode-trigger"
                            aria-label="Document mode"
                            className="document-tool-button [&_[data-slot=select-icon]]:hidden"
                          >
                            <ActiveDocumentInteractionModeIcon
                              className="size-4"
                              aria-hidden="true"
                            />
                            <span className="sr-only">
                              {activeDocumentInteractionMode?.label}
                            </span>
                          </SelectTrigger>
                        }
                      />
                      <TooltipContent side="right">
                        Choose how to work with this document. Editing changes
                        text; Suggesting records proposals; Viewing prevents
                        edits.
                      </TooltipContent>
                    </Tooltip>
                    <SelectContent side="right" align="start">
                      {documentInteractionModeOptions.map(
                        ({ value, label, Icon }) => (
                          <SelectItem
                            key={value}
                            value={value}
                            label={label}
                            data-testid={`document-mode-${value}`}
                            className="text-[0.8rem]"
                          >
                            <Icon className="size-3 text-stone-500 dark:text-slate-400" />
                            <SelectItemText className="font-medium">
                              {label}
                            </SelectItemText>
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </div>
                {documentPageForEditor &&
                documentCopyPath &&
                backend?.info.kind === "local-files" &&
                backend.info.capabilities?.reviewRevisions === true ? (
                  <RevisionReview
                    key={documentCopyPath}
                    documentPath={documentCopyPath}
                    markdown={documentPageForEditor.content}
                    refreshKey={`${documentPage?.version ?? documentPage?.content ?? ""}:${documentDiskChangeState}:${reviewHandoffState}`}
                    onRestore={handleRestoreRevision}
                    restoreDisabledReason={restoreDisabledReason}
                    editor={
                      documentEditorViewMode === "rich-text"
                        ? revisionEditor
                        : null
                    }
                    legendContainer={revisionLegendContainer}
                  />
                ) : null}
              </div>
              <div
                ref={setRevisionLegendContainer}
                className="document-version-legend-host"
              />
            </div>
          ) : null}
          {documentPageForEditor ? (
            backend ? (
              <PageCard
                key={`${documentPageForEditor.id}:${activeDocumentPath ?? ""}`}
                page={documentPageForEditor}
                activeDocumentPath={activeDocumentPath}
                selected
                onSave={handleSaveDocumentWithDraft}
                onSaveStateChange={handleSaveStateChange}
                onAutosaveDeadlineChange={setAutosaveDeadline}
                editorViewMode={documentEditorViewMode}
                interactionMode={
                  restoringRevision ||
                  reviewHandoffState === "notifying" ||
                  draftActionPending
                    ? "viewing"
                    : documentInteractionMode
                }
                backend={backend}
                onEditorReady={setRevisionEditor}
                onCodeNavigationReady={setCodeNavigation}
                onOutlineChange={setOutlineHeadings}
                onCommentRailPresenceChange={setDocumentHasComments}
                onDirtyStateChange={handleDocumentDirtyStateChange}
                onLocalContentChange={handleDocumentLocalContentChange}
                onSaveControllerChange={(controller) => {
                  saveControllerRef.current = controller;
                }}
                saveBlocked={
                  documentDiskChangeState !== "clean" ||
                  draftBlocksSave ||
                  restoringRevision
                }
                forceResetKey={documentForceResetKey}
                initiallyDirty={draftIsSafeRecovered || draftHasLocalRecovery}
              />
            ) : null
          ) : (
            <div className="flex min-h-[50vh] items-center justify-center text-sm text-slate-500 dark:text-slate-400">
              Open a markdown file to begin.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
