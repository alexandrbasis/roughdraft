import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getFriendlyReviewRouteFromLocation,
  resolveReviewRoute,
} from "./review-route";

afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("friendly review routes", () => {
  it("accepts exactly two safe route segments and preserves the pathname", () => {
    window.history.replaceState(null, "", "/admitad/launch-plan?embed=1");

    expect(getFriendlyReviewRouteFromLocation()).toBe("/admitad/launch-plan");
    expect(window.location.pathname).toBe("/admitad/launch-plan");
  });

  it("does not reinterpret legacy path or remote query routes", () => {
    expect(
      getFriendlyReviewRouteFromLocation({
        pathname: "/admitad/launch-plan",
        search: "?path=%2Ftmp%2Fplan.md",
      }),
    ).toBeNull();
    expect(
      getFriendlyReviewRouteFromLocation({
        pathname: "/",
        search: "?session=remote-1",
      }),
    ).toBeNull();
    expect(
      getFriendlyReviewRouteFromLocation({
        pathname: "/admitad/launch.plan",
        search: "",
      }),
    ).toBeNull();
  });

  it("resolves through the exact API route", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          route: "/admitad/launch-plan",
          projectName: "Admitad",
          title: "Launch plan",
          projectPath: "/tmp/admitad",
          relativePath: "plans/launch.md",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      resolveReviewRoute("/admitad/launch-plan", fetchImpl),
    ).resolves.toMatchObject({
      projectPath: "/tmp/admitad",
      relativePath: "plans/launch.md",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/reviews/resolve?route=%2Fadmitad%2Flaunch-plan",
    );
  });
});
