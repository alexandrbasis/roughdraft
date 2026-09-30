import type { DocumentRevision } from "./types";

export async function loadRevisions(
  documentPath: string,
  signal: AbortSignal,
): Promise<DocumentRevision[]> {
  const response = await fetch(
    `/api/reviews/revisions?${new URLSearchParams({ documentPath })}`,
    { signal, cache: "no-store" },
  );
  if (!response.ok) throw new Error("Could not load document revisions.");
  const result = await response.json();
  if (!result || !Array.isArray(result.revisions))
    throw new Error("Invalid document revision history.");

  const ids = new Set<string>();
  let previousNumber = -1;
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
      !["baseline", "external", "review"].includes(revision.source)
    )
      throw new Error("Invalid document revision history.");
    ids.add(revision.id);
    previousNumber = revision.number;
  }
  return result.revisions;
}
