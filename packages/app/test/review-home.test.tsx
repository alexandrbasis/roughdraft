import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewHome } from "../src/review-home/ReviewHome";

describe("ReviewHome", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows project, title, waiting state, watcher count, and readable link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: "review_1",
              route: "/atlas/launch-plan",
              projectName: "Atlas",
              title: "Launch plan",
              status: "pending",
              watcherCount: 1,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await act(async () => {
      root.render(<ReviewHome />);
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="review-home"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Atlas");
    expect(container.textContent).toContain("Launch plan");
    expect(container.textContent).toContain("Waiting");
    expect(container.textContent).toContain("1 agent watching");
    expect(
      container
        .querySelector('[data-testid="review-home-item"]')
        ?.getAttribute("href"),
    ).toBe("/atlas/launch-plan");
  });

  it("shows a retry state and keeps the last list when a refresh fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: "review_1",
              route: "/atlas/launch-plan",
              projectName: "Atlas",
              title: "Launch plan",
              status: "pending",
              watcherCount: 1,
            },
          ]),
          { status: 200 },
        ),
      )
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(<ReviewHome />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Launch plan");

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Could not load reviews.");
    expect(container.textContent).toContain(
      "Showing the last successful list.",
    );
    expect(container.textContent).toContain("Launch plan");

    await act(async () => {
      const retry = container.querySelector<HTMLButtonElement>(
        '[data-testid="review-home-retry"]',
      );
      retry?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="review-home"]')).toBeNull();
  });

  it("refreshes watcher counts on a five second interval", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: "review_1",
              route: "/atlas/launch-plan",
              projectName: "Atlas",
              title: "Launch plan",
              status: "pending",
              watcherCount: 1,
            },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: "review_1",
              route: "/atlas/launch-plan",
              projectName: "Atlas",
              title: "Launch plan",
              status: "pending",
              watcherCount: 5,
            },
          ]),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(<ReviewHome />);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("1 agent watching");

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("5 agents watching");
  });
});
