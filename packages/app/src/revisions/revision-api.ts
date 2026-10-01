import type { DocumentRevision, RecoveryPoint } from "./types";

export interface RevisionHistory {
  revisions: DocumentRevision[];
  recoveryPoints: RecoveryPoint[];
}

export async function loadRevisions(
  documentPath: string,
  signal: AbortSignal,
): Promise<RevisionHistory> {
  const response = await fetch(
    `/api/reviews/revisions?${new URLSearchParams({ documentPath })}`,
    { signal, cache: "no-store" },
  );
  if (!response.ok) throw new Error("Could not load document revisions.");
  const result = await response.json();
  if (
    !result ||
    !Array.isArray(result.revisions) ||
    !Array.isArray(result.recoveryPoints)
  )
    throw new Error("Invalid document revision history.");

  const ids = new Set<string>();
  let previousNumber = 0;
  for (const revision of result.revisions) {
    if (
      !revision ||
      typeof revision.id !== "string" ||
      !revision.id ||
      ids.has(revision.id) ||
      !Number.isSafeInteger(revision.number) ||
      revision.number !== previousNumber + 1 ||
      typeof revision.content !== "string" ||
      typeof revision.version !== "string" ||
      !revision.version ||
      typeof revision.createdAt !== "string" ||
      !Number.isFinite(Date.parse(revision.createdAt)) ||
      !["agent", "user", "unknown"].includes(revision.actor) ||
      (revision.actor === "unknown"
        ? revision.completedAt !== null
        : typeof revision.completedAt !== "string" ||
          !Number.isFinite(Date.parse(revision.completedAt))) ||
      (revision.author !== undefined &&
        (typeof revision.author !== "string" || !revision.author.trim())) ||
      !["baseline", "external", "review"].includes(revision.source)
    )
      throw new Error("Invalid document revision history.");
    ids.add(revision.id);
    previousNumber = revision.number;
  }
  const recoveryIds = new Set<string>();
  for (const point of result.recoveryPoints) {
    if (
      !point ||
      typeof point.id !== "string" ||
      !point.id ||
      recoveryIds.has(point.id) ||
      typeof point.documentPath !== "string" ||
      !point.documentPath ||
      typeof point.content !== "string" ||
      typeof point.version !== "string" ||
      !point.version ||
      typeof point.createdAt !== "string" ||
      !Number.isFinite(Date.parse(point.createdAt)) ||
      typeof point.reason !== "string" ||
      !point.reason
    )
      throw new Error("Invalid document recovery history.");
    recoveryIds.add(point.id);
  }
  return {
    revisions: result.revisions,
    recoveryPoints: result.recoveryPoints,
  };
}
