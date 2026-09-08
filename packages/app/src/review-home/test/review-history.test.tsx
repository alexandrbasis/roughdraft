import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewHome } from "../ReviewHome";

const documentPath = "/Atlas plans/launch #1 & notes.md";
const review = {
  id: "review-current",
  route: "/atlas/launch-plan",
  documentPath,
  projectName: "Atlas",
  title: "Launch plan",
  status: "completed",
  watcherCount: 3,
};
const snapshot = {
  id: "snapshot/one #1",
  documentPath,
  version: "snapshot-version",
  createdAt: "2026-09-08T08:00:00Z",
  reason: "before-review",
};
const snapshotInfo = {
  ...snapshot,
  content: "# Original plan\n\nKeep this exact text.",
  currentVersion: "live-version-before-inspection",
};
const emptyHistory = {
  rounds: [],
  snapshots: [],
  acknowledgements: [],
  writes: [],
};
const snapshotPath = `/api/reviews/snapshots/${encodeURIComponent(snapshot.id)}`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Native DOM interactions keep the real Dialog mounted, including its portal.
function accessibleName(element: HTMLElement): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  return (
    (labelledBy
      ? labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
      : element.getAttribute("aria-label")) ??
    element.textContent ??
    ""
  ).trim();
}

function button(name: string | RegExp, scope: ParentNode = document.body) {
  const matches = [
    ...scope.querySelectorAll<HTMLButtonElement>("button"),
  ].filter((element) =>
    typeof name === "string"
      ? accessibleName(element) === name
      : name.test(accessibleName(element)),
  );
  expect(matches, `button named ${String(name)}`).toHaveLength(1);
  return matches[0];
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

function dialog() {
  const element = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(element, "snapshot dialog").not.toBeNull();
  return element as HTMLElement;
}

function announcements() {
  return [
    ...document.querySelectorAll(
      '[role="alert"], [role="status"], [aria-live]',
    ),
  ]
    .map((element) => element.textContent)
    .join(" ");
}

describe("ReviewHome review history", () => {
  let container: HTMLDivElement;
  let root: Root;
  let requests: { url: URL; method: string; body: unknown }[];
  let list: (typeof review)[];
  let historyReply: () => Response | Promise<Response>;
  let snapshotReply: () => Response | Promise<Response>;
  let restoreReply: () => Response | Promise<Response>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    requests = [];
    list = [{ ...review }];
    historyReply = () => json({ ...emptyHistory, snapshots: [snapshot] });
    snapshotReply = () => json(snapshotInfo);
    restoreReply = () => json({ restored: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
          window.location.origin,
        );
        const method = (
          init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        const body = init?.body
          ? JSON.parse(String(init.body))
          : input instanceof Request && method !== "GET"
            ? await input.clone().json()
            : undefined;
        requests.push({ url, method, body });
        if (url.pathname === "/api/reviews" && method === "GET")
          return json(list);
        if (url.pathname === "/api/reviews/history" && method === "GET")
          return historyReply();
        if (url.pathname === snapshotPath && method === "GET")
          return snapshotReply();
        if (url.pathname === `${snapshotPath}/restore` && method === "POST")
          return restoreReply();
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function render() {
    await act(async () => {
      root.render(<ReviewHome reviewHistorySupported />);
    });
  }

  function reads(path: string) {
    return requests.filter(
      ({ url, method }) => url.pathname === path && method === "GET",
    );
  }

  function writes() {
    return requests.filter(({ method }) => method !== "GET");
  }

  async function expand() {
    await click(button(`History for ${review.title}`, container));
    const id = button(`History for ${review.title}`, container).getAttribute(
      "aria-controls",
    );
    expect(id, "history button controls a panel").toBeTruthy();
    const panel = document.getElementById(id as string);
    expect(panel).not.toBeNull();
    return panel as HTMLElement;
  }

  async function inspect() {
    await render();
    await expand();
    await click(button(`View snapshot ${snapshot.id}`, container));
  }

  it.each([
    false,
    undefined,
  ])("hides history without capability (%s) and makes no history requests", async (supported) => {
    // Passing undefined explicitly must exercise the component's default prop.
    await act(async () => {
      root.render(
        supported === undefined ? (
          <ReviewHome />
        ) : (
          <ReviewHome reviewHistorySupported={supported} />
        ),
      );
    });
    expect(
      container.querySelector('[data-testid="review-history-toggle"]'),
    ).toBeNull();
    expect(container.querySelector(`a[href="${review.route}"]`)).not.toBeNull();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(
      requests.every(
        ({ url, method }) =>
          url.pathname === "/api/reviews" && method === "GET",
      ),
    ).toBe(true);
  });

  it("hides history when the review has no document path", async () => {
    list = [{ ...review, documentPath: "" }];
    await render();
    expect(
      [
        ...container.querySelectorAll<HTMLElement>(
          '[data-testid="review-history-toggle"]',
        ),
      ].some(
        (element) => accessibleName(element) === `History for ${review.title}`,
      ),
    ).toBe(false);
    expect(reads("/api/reviews/history")).toHaveLength(0);
  });

  it("expands and collapses an accessible panel without replacing or nesting the direct link", async () => {
    await render();
    const toggle = button(`History for ${review.title}`, container);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.closest("a")).toBeNull();
    expect(reads("/api/reviews/history")).toHaveLength(0);
    const panel = await expand();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hidden).toBe(false);
    expect(reads("/api/reviews/history")).toHaveLength(1);
    expect(
      reads("/api/reviews/history")[0].url.searchParams.get("documentPath"),
    ).toBe(documentPath);
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      !panel.isConnected ||
        panel.hidden ||
        panel.getAttribute("aria-hidden") === "true",
    ).toBe(true);
    expect(container.querySelector(`a[href="${review.route}"]`)).not.toBeNull();
    expect(reads("/api/reviews/history")).toHaveLength(1);
  });

  it.each([
    {
      eventSequence: 10,
      consumer: "agent-received",
      delivery: "received",
      absent: "agent-processed",
    },
    {
      eventSequence: 11,
      consumer: "agent-processed",
      delivery: "processed",
      absent: "agent-received",
    },
    {
      eventSequence: undefined,
      consumer: null,
      delivery: null,
      absent: "agent-processed",
    },
  ])("maps delivery only to round eventSequence $eventSequence", async ({
    eventSequence,
    consumer,
    delivery,
    absent,
  }) => {
    historyReply = () =>
      json({
        ...emptyHistory,
        rounds: [
          {
            id: "round-completed",
            documentPath,
            openedAt: snapshot.createdAt,
            completedAt: snapshot.createdAt,
            status: "completed",
            eventSequence,
          },
        ],
        acknowledgements: [
          {
            sequence: 10,
            consumerId: "agent-received",
            status: "received",
            updatedAt: snapshot.createdAt,
          },
          {
            sequence: 11,
            consumerId: "agent-processed",
            status: "processed",
            updatedAt: snapshot.createdAt,
          },
        ],
      });
    await render();
    const panel = await expand();
    expect(panel.textContent).toContain("Round 1");
    expect(panel.textContent).not.toContain(absent);
    if (consumer) {
      expect(panel.textContent).toContain(consumer);
      expect(panel.textContent?.toLowerCase()).toContain(delivery);
    } else {
      expect(panel.textContent).not.toContain("agent-received");
    }
    // Completion and the three live watchers are not a processing receipt.
    if (delivery !== "processed")
      expect(panel.textContent).not.toMatch(/\bprocessed\b/i);
  });

  it("shows an empty history without offering snapshot restore", async () => {
    historyReply = () => json(emptyHistory);
    await render();
    const panel = await expand();
    expect(panel.textContent).toMatch(
      /no .*?(history|rounds|reviews|snapshots)|nothing .*?yet/i,
    );
    expect(
      [
        ...panel.querySelectorAll<HTMLElement>(
          '[data-testid="review-snapshot-view"]',
        ),
      ].some((element) => /snapshot/i.test(accessibleName(element))),
    ).toBe(false);
    expect(writes()).toHaveLength(0);
  });

  it("keeps acknowledgements with their own round when several rounds are visible", async () => {
    historyReply = () =>
      json({
        ...emptyHistory,
        rounds: [
          {
            id: "older-round",
            documentPath,
            openedAt: snapshot.createdAt,
            status: "completed",
            eventSequence: 10,
          },
          {
            id: "newer-round",
            documentPath,
            openedAt: snapshot.createdAt,
            status: "pending",
            eventSequence: 11,
          },
        ],
        acknowledgements: [
          {
            sequence: 11,
            consumerId: "new-agent",
            status: "processed",
            updatedAt: snapshot.createdAt,
          },
          {
            sequence: 10,
            consumerId: "old-agent",
            status: "received",
            updatedAt: snapshot.createdAt,
          },
        ],
      });
    await render();
    const panel = await expand();
    for (const [id, ownReceipt, otherAgent] of [
      ["older-round", /old-agent:\s*received/i, "new-agent"],
      ["newer-round", /new-agent:\s*processed/i, "old-agent"],
    ] as const) {
      const round = panel.querySelector(
        `[data-testid="review-history-round"][data-round-id="${id}"]`,
      );
      expect(round, `visible round ${id}`).not.toBeNull();
      expect(round?.textContent).toMatch(ownReceipt);
      expect(round?.textContent).not.toContain(otherAgent);
    }
  });

  it("announces a history error and retries the read explicitly", async () => {
    historyReply = () => json({ error: "History unavailable" }, 503);
    await render();
    const panel = await expand();
    expect(announcements()).toMatch(/could not|failed|unavailable/i);
    historyReply = () => json({ ...emptyHistory, snapshots: [snapshot] });
    await click(button(/retry/i, panel));
    expect(button(`View snapshot ${snapshot.id}`, panel)).toBeTruthy();
    expect(reads("/api/reviews/history")).toHaveLength(2);
    expect(writes()).toHaveLength(0);
  });

  it("inspects snapshot content read-only and disables restore until it loads", async () => {
    const loading = deferred<Response>();
    snapshotReply = () => loading.promise;
    await inspect();
    expect(button("Restore snapshot", dialog()).disabled).toBe(true);
    await click(button("Restore snapshot", dialog()));
    expect(writes()).toHaveLength(0);
    expect(reads(snapshotPath)).toHaveLength(1);
    expect(reads(snapshotPath)[0].url.searchParams.get("documentPath")).toBe(
      documentPath,
    );
    await act(async () => loading.resolve(json(snapshotInfo)));
    expect(dialog().textContent).toContain(snapshotInfo.content);
    expect(button("Restore snapshot", dialog()).disabled).toBe(false);
    expect(writes()).toHaveLength(0);
  });

  it("shows the snapshot but disables restore when the current file is unavailable", async () => {
    snapshotReply = () => json({ ...snapshotInfo, currentVersion: null });
    await inspect();
    expect(dialog().textContent).toContain(snapshotInfo.content);
    expect(announcements()).toMatch(/file.*unavailable/i);
    expect(button("Restore snapshot", dialog()).disabled).toBe(true);
    await click(button("Restore snapshot", dialog()));
    expect(writes()).toHaveLength(0);
  });

  it("retries a failed snapshot read explicitly before enabling restore", async () => {
    snapshotReply = () => json({ error: "Snapshot unavailable" }, 503);
    await inspect();
    expect(announcements()).toMatch(/could not load snapshot/i);
    expect(button("Restore snapshot", dialog()).disabled).toBe(true);
    snapshotReply = () => json(snapshotInfo);
    await click(button("Reload snapshot", dialog()));
    expect(dialog().textContent).toContain(snapshotInfo.content);
    expect(button("Restore snapshot", dialog()).disabled).toBe(false);
    expect(reads(snapshotPath)).toHaveLength(2);
    expect(writes()).toHaveLength(0);
  });

  it("restores with the inspected current version, disables duplicate writes, and refreshes history", async () => {
    const saving = deferred<Response>();
    restoreReply = () => saving.promise;
    await inspect();
    await click(button("Restore snapshot", dialog()));
    expect(writes()).toHaveLength(1);
    expect(writes()[0].url.pathname).toBe(`${snapshotPath}/restore`);
    expect(writes()[0].body).toEqual({
      documentPath,
      expectedVersion: snapshotInfo.currentVersion,
    });
    expect(button(/restor/i, dialog()).disabled).toBe(true);
    await click(button(/restor/i, dialog()));
    expect(writes()).toHaveLength(1);
    await act(async () => saving.resolve(json({ restored: true })));
    expect(announcements()).toMatch(/restored/i);
    expect(reads("/api/reviews/history")).toHaveLength(2);
    expect(writes()).toHaveLength(1);
  });

  it.each([
    409,
    500,
    "network",
  ])("reloads after restore failure %s and uses the new token only after another explicit click", async (status) => {
    await inspect();
    const reloading = deferred<Response>();
    snapshotReply = () => reloading.promise;
    restoreReply = () => {
      if (status === "network") throw new TypeError("Failed to fetch");
      return json(
        { error: "The file changed or restore failed." },
        status as number,
      );
    };
    await click(button("Restore snapshot", dialog()));
    expect(announcements()).toMatch(/changed|conflict|failed|could not/i);
    expect(reads(snapshotPath)).toHaveLength(2);
    expect(writes()).toHaveLength(1);
    expect(button(/restor/i, dialog()).disabled).toBe(true);
    await click(button(/restor/i, dialog()));
    expect(writes()).toHaveLength(1);
    await act(async () =>
      reloading.resolve(
        json({ ...snapshotInfo, currentVersion: "new-live-version" }),
      ),
    );
    expect(reads("/api/reviews/history")).toHaveLength(2);
    expect(button("Restore snapshot", dialog()).disabled).toBe(false);
    expect(writes()).toHaveLength(1);
    restoreReply = () => json({ restored: true });
    await click(button("Restore snapshot", dialog()));
    expect(writes()).toHaveLength(2);
    expect(writes()[1].body).toEqual({
      documentPath,
      expectedVersion: "new-live-version",
    });
  });

  it("keeps restore disabled if snapshot reload fails after conflict", async () => {
    await inspect();
    restoreReply = () => json({ error: "The file changed." }, 409);
    snapshotReply = () => json({ error: "Snapshot reload unavailable" }, 503);
    await click(button("Restore snapshot", dialog()));
    expect(reads(snapshotPath)).toHaveLength(2);
    expect(reads("/api/reviews/history")).toHaveLength(2);
    expect(announcements()).toMatch(/failed|could not|unavailable/i);
    expect(button(/restor/i, dialog()).disabled).toBe(true);
    await click(button(/restor/i, dialog()));
    expect(writes()).toHaveLength(1);
  });
});
