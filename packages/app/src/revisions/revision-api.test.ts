import { afterEach, expect, it, vi } from "vitest";
import { loadRevisions } from "./revision-api";

const firstSeen = {
  id: "first-edition",
  number: 1,
  content: "Original text",
  version: "hash-1",
  source: "baseline",
  createdAt: "2026-09-29T10:00:00.000Z",
  completedAt: null,
  actor: "unknown",
};

afterEach(() => vi.unstubAllGlobals());

async function load(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => payload }),
  );
  return loadRevisions("/tmp/review.md", new AbortController().signal);
}

it("accepts a first-seen edition without inventing a completion time", async () => {
  const history = await load({ revisions: [firstSeen], recoveryPoints: [] });
  expect(history.revisions[0]).toMatchObject({
    actor: "unknown",
    createdAt: firstSeen.createdAt,
    completedAt: null,
  });
});

it("requires a real completion time for an agent or user handoff", async () => {
  for (const actor of ["agent", "user"]) {
    await expect(
      load({
        revisions: [{ ...firstSeen, actor, completedAt: null }],
        recoveryPoints: [],
      }),
    ).rejects.toThrow("Invalid document revision history.");
  }
});

it("does not treat an unknown first observation as completed", async () => {
  await expect(
    load({
      revisions: [{ ...firstSeen, completedAt: firstSeen.createdAt }],
      recoveryPoints: [],
    }),
  ).rejects.toThrow("Invalid document revision history.");
});
