import { describe, expect, it } from "vitest";
import { getDockClearanceScrollDelta } from "../src/comment-dock";

describe("comment dock clearance", () => {
  const viewport = { viewportTop: 0, dockTop: 600 };

  it("leaves a fully visible passage in place", () => {
    expect(
      getDockClearanceScrollDelta({
        ...viewport,
        anchorTop: 200,
        anchorBottom: 240,
      }),
    ).toBe(0);
  });

  it("moves a covered passage only far enough above the dock", () => {
    expect(
      getDockClearanceScrollDelta({
        ...viewport,
        anchorTop: 610,
        anchorBottom: 640,
      }),
    ).toBe(56);
  });

  it("brings a passage above the scroll region back into view", () => {
    expect(
      getDockClearanceScrollDelta({
        ...viewport,
        anchorTop: -40,
        anchorBottom: -10,
      }),
    ).toBe(-56);
  });

  it("shows the start of a selection taller than the available region", () => {
    expect(
      getDockClearanceScrollDelta({
        ...viewport,
        anchorTop: 100,
        anchorBottom: 900,
      }),
    ).toBe(84);
  });

  it("does not scroll when the dock leaves no readable area", () => {
    expect(
      getDockClearanceScrollDelta({
        viewportTop: 100,
        dockTop: 120,
        anchorTop: 300,
        anchorBottom: 340,
      }),
    ).toBe(0);
  });
});
