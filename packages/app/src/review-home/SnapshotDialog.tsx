import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { historyDate, loadSnapshot, type ReviewSnapshot } from "./history-api";

export function SnapshotDialog({
  snapshotId,
  documentPath,
  title,
  onClose,
  onRefresh,
  returnFocus,
}: {
  snapshotId: string;
  documentPath: string;
  title: string;
  onClose: () => void;
  onRefresh: () => void;
  returnFocus: HTMLElement | null;
}) {
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [revision, setRevision] = useState(0);
  const writing = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision invalidates the version token and requests a fresh read.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(false);
    setSnapshot(null);
    void loadSnapshot(snapshotId, documentPath, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setSnapshot(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [snapshotId, documentPath, revision]);

  async function restore() {
    if (!snapshot?.currentVersion || loading || writing.current) return;
    writing.current = true;
    setRestoring(true);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/reviews/snapshots/${encodeURIComponent(snapshotId)}/restore`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            documentPath,
            expectedVersion: snapshot.currentVersion,
          }),
        },
      );
      if (response.status === 409) {
        throw new Error(
          "The document changed. Review the latest information before restoring again.",
        );
      }
      if (!response.ok || (await response.json()).restored !== true) {
        throw new Error(
          "Could not confirm the restore. Review the latest information before trying again.",
        );
      }
      if (mounted.current) {
        setNotice({ text: "Snapshot restored.", error: false });
      }
    } catch (error) {
      if (mounted.current) {
        setNotice({
          text:
            error instanceof Error && error.message.startsWith("The document")
              ? error.message
              : "Could not confirm the restore. Review the latest information before trying again.",
          error: true,
        });
      }
    } finally {
      writing.current = false;
      if (mounted.current) {
        // Discard the old CAS token even after an uncertain network result.
        // A fresh read and another explicit click are required for another write.
        setSnapshot(null);
        setLoading(true);
        setRestoring(false);
        setRevision((value) => value + 1);
        onRefresh();
      }
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !writing.current) onClose();
      }}
    >
      <DialogContent
        className="max-h-[85dvh] max-w-3xl overflow-y-auto"
        finalFocus={returnFocus ? { current: returnFocus } : undefined}
        showCloseButton={!restoring}
      >
        <DialogHeader>
          <DialogTitle>Snapshot for {title}</DialogTitle>
          <DialogDescription>
            Inspect this saved content before restoring. Restore replaces the
            current file with this snapshot.
          </DialogDescription>
        </DialogHeader>
        <div role="status" data-testid="review-snapshot-status">
          {restoring
            ? "Restoring snapshot…"
            : loading
              ? "Loading snapshot…"
              : null}
          {notice && !notice.error ? notice.text : null}
        </div>
        {notice?.error ? (
          <p role="alert" data-testid="review-snapshot-error">
            {notice.text}
          </p>
        ) : null}
        {loadError ? (
          <div className="space-y-2">
            <p role="alert">Could not load snapshot. Restore is unavailable.</p>
            <Button variant="outline" onClick={() => setRevision((v) => v + 1)}>
              Reload snapshot
            </Button>
          </div>
        ) : null}
        {snapshot ? (
          <>
            <div className="space-y-1 break-all text-xs text-muted-foreground">
              <p>{documentPath}</p>
              <p>
                {snapshot.reason} · {historyDate(snapshot.createdAt)}
              </p>
              <p>Snapshot version: {snapshot.version}</p>
              <p>
                Current version: {snapshot.currentVersion ?? "File unavailable"}
              </p>
            </div>
            <pre
              role="region"
              aria-label="Snapshot content"
              data-testid="review-snapshot-content"
              className="max-h-[45dvh] overflow-auto rounded-md border bg-muted/30 p-4 text-sm whitespace-pre-wrap break-words"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to focus this scrollable snapshot to read all its content.
              tabIndex={0}
            >
              {snapshot.content}
            </pre>
            {snapshot.currentVersion === null ? (
              <p role="alert">
                The current file is unavailable. Restore is disabled.
              </p>
            ) : null}
          </>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={restoring} onClick={onClose}>
            Close
          </Button>
          <Button
            data-testid="review-snapshot-restore"
            disabled={loading || restoring || !snapshot?.currentVersion}
            onClick={() => void restore()}
          >
            Restore snapshot
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
