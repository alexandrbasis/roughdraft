export interface ReviewHistoryRecord {
  rounds: {
    id: string;
    documentPath: string;
    openedAt: string;
    status: "pending" | "completed";
    completedAt?: string;
    eventSequence?: number;
  }[];
  snapshots: {
    id: string;
    documentPath: string;
    version: string;
    createdAt: string;
    reason: string;
  }[];
  acknowledgements: {
    sequence: number;
    consumerId: string;
    status: "received" | "processed";
    updatedAt: string;
  }[];
  writes: { id: string; status: "pending" | "conflict" }[];
}

export interface ReviewSnapshot {
  id: string;
  content: string;
  version: string;
  currentVersion: string | null;
  createdAt: string;
  reason: string;
}

export function historyUrl(documentPath: string): string {
  return `/api/reviews/history?${new URLSearchParams({ documentPath })}`;
}

export function snapshotUrl(id: string, documentPath: string): string {
  return `/api/reviews/snapshots/${encodeURIComponent(id)}?${new URLSearchParams({ documentPath })}`;
}

export async function loadHistory(
  documentPath: string,
  signal: AbortSignal,
): Promise<ReviewHistoryRecord> {
  const response = await fetch(historyUrl(documentPath), { signal });
  if (!response.ok) throw new Error("Could not load history.");
  const result = (await response.json()) as ReviewHistoryRecord;
  if (
    !result ||
    !Array.isArray(result.rounds) ||
    !Array.isArray(result.snapshots) ||
    !Array.isArray(result.acknowledgements) ||
    !Array.isArray(result.writes)
  ) {
    throw new Error("Could not load history.");
  }
  return result;
}

export async function loadSnapshot(
  id: string,
  documentPath: string,
  signal: AbortSignal,
): Promise<ReviewSnapshot> {
  const response = await fetch(snapshotUrl(id, documentPath), { signal });
  if (!response.ok) throw new Error("Could not load snapshot.");
  const result = (await response.json()) as ReviewSnapshot;
  if (
    !result ||
    result.id !== id ||
    typeof result.content !== "string" ||
    typeof result.version !== "string" ||
    (result.currentVersion !== null &&
      (typeof result.currentVersion !== "string" || !result.currentVersion))
  ) {
    throw new Error("Could not load snapshot.");
  }
  return result;
}

export function historyDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
