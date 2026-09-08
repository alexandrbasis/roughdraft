import { ChevronDown } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "../components/ui/button";
import {
  historyDate,
  loadHistory,
  type ReviewHistoryRecord,
} from "./history-api";
import { SnapshotDialog } from "./SnapshotDialog";

export function ReviewHistory({
  documentPath,
  title,
}: {
  documentPath: string;
  title: string;
}) {
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-t border-slate-200 px-5 py-2 dark:border-slate-700">
      <Button
        data-testid="review-history-toggle"
        aria-label={`History for ${title}`}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="h-8 gap-1.5"
        variant="ghost"
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronDown
          aria-hidden="true"
          className={expanded ? "rotate-180" : ""}
        />
        History
      </Button>
      <div id={panelId} hidden={!expanded}>
        {expanded ? (
          <HistoryDetails
            key={documentPath}
            documentPath={documentPath}
            title={title}
          />
        ) : null}
      </div>
    </div>
  );
}

function HistoryDetails({
  documentPath,
  title,
}: {
  documentPath: string;
  title: string;
}) {
  const [history, setHistory] = useState<ReviewHistoryRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<{
    id: string;
    trigger: HTMLElement;
  } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly refreshes this resource without changing its path.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    void loadHistory(documentPath, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setHistory(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [documentPath, revision]);

  return (
    <section
      aria-label={`Review history for ${title}`}
      className="space-y-4 py-3 text-sm text-slate-700 dark:text-slate-200"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold">Review history</h4>
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => setRevision((v) => v + 1)}
        >
          {error ? "Retry history" : "Refresh history"}
        </Button>
      </div>
      <p role="status">{loading ? "Loading history…" : null}</p>
      {error ? (
        <p role="alert">
          Could not load history.
          {history ? " Showing the last loaded history." : ""}
        </p>
      ) : null}
      {history ? (
        <>
          {history.writes.length ? (
            <div className="space-y-1 rounded-md border p-3" role="status">
              {history.writes.map((write) => (
                <p className="break-words" key={write.id}>
                  {write.status === "conflict"
                    ? "Write conflict"
                    : "Write pending"}
                  : {write.id}
                </p>
              ))}
            </div>
          ) : null}
          <div>
            <h5 className="mb-2 font-medium">Rounds</h5>
            {history.rounds.length ? (
              <ul className="space-y-3">
                {history.rounds.map((round, index) => {
                  const acknowledgements =
                    round.eventSequence === undefined
                      ? []
                      : history.acknowledgements.filter(
                          (ack) => ack.sequence === round.eventSequence,
                        );
                  return (
                    <li
                      key={round.id}
                      data-testid="review-history-round"
                      data-round-id={round.id}
                      className="space-y-1 border-l-2 border-slate-200 pl-3 dark:border-slate-700"
                    >
                      <p className="break-words">
                        <span className="font-medium">
                          Round {history.rounds.length - index}
                        </span>{" "}
                        ·{" "}
                        {round.status === "completed" ? "Completed" : "Pending"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Opened {historyDate(round.openedAt)}
                        {round.completedAt
                          ? ` · Completed ${historyDate(round.completedAt)}`
                          : ""}
                      </p>
                      {acknowledgements.length ? (
                        <ul
                          aria-label={`Delivery for ${round.id}`}
                          className="space-y-1 text-xs"
                        >
                          {acknowledgements.map((ack) => (
                            <li
                              className="break-words"
                              key={`${ack.sequence}:${ack.consumerId}`}
                            >
                              {ack.consumerId}:{" "}
                              {ack.status === "processed"
                                ? "Processed"
                                : ack.status === "received"
                                  ? "Received"
                                  : "Unknown"}{" "}
                              · {historyDate(ack.updatedAt)}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          No delivery acknowledgement recorded.
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-muted-foreground">No review rounds yet.</p>
            )}
          </div>
          <div>
            <h5 className="mb-2 font-medium">Snapshots</h5>
            {history.snapshots.length ? (
              <ul className="space-y-2">
                {history.snapshots.map((snapshot) => (
                  <li
                    key={snapshot.id}
                    className="flex flex-wrap items-center justify-between gap-2"
                  >
                    <span className="min-w-0 break-words text-xs">
                      {(
                        {
                          opened: "Review opened",
                          "before-save": "Before saving",
                          "proposed-save": "Proposed change",
                        } as Record<string, string>
                      )[snapshot.reason] ?? snapshot.reason}{" "}
                      · {historyDate(snapshot.createdAt)}
                    </span>
                    <Button
                      data-testid="review-snapshot-view"
                      aria-label={`View snapshot ${snapshot.id}`}
                      variant="outline"
                      onClick={(event) =>
                        setSelection({
                          id: snapshot.id,
                          trigger: event.currentTarget,
                        })
                      }
                    >
                      View snapshot
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No snapshots yet.</p>
            )}
          </div>
        </>
      ) : null}
      {selection ? (
        <SnapshotDialog
          key={selection.id}
          snapshotId={selection.id}
          documentPath={documentPath}
          title={title}
          returnFocus={selection.trigger}
          onClose={() => setSelection(null)}
          onRefresh={() => setRevision((v) => v + 1)}
        />
      ) : null}
    </section>
  );
}
