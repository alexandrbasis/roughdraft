import { expect, type Page, test } from "@playwright/test";
import { logE2eEvent } from "./helpers";

const routeRecord = {
  id: "review_atlas_launch",
  route: "/atlas/launch-plan",
  documentPath: "/tmp/atlas/plans/launch.md",
  projectPath: "/tmp/atlas",
  relativePath: "plans/launch.md",
  projectName: "Atlas",
  title: "Launch plan",
  status: "pending",
  watcherCount: 1,
  waiting: true,
  reviewed: false,
};

async function mockLocalReviewApi(page: Page, statusGate: Promise<void>) {
  await page.route("**/api/status", async (route) => {
    await statusGate;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        backend: "local-files",
        projectDir: "/tmp",
        stateless: true,
        capabilities: { remoteDocuments: true },
      }),
    });
  });
  await page.route("**/api/update-status", (route) =>
    route.fulfill({ contentType: "application/json", body: "null" }),
  );
  await page.route("**/api/reviews/resolve**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(routeRecord),
    }),
  );
  await page.route("**/api/reviews", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([routeRecord]),
    }),
  );
  await page.route("**/api/markdown-file**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "plans/launch",
        title: "Launch plan",
        content: "# Launch plan\n\nA readable review route.\n",
        version: "fixture:1",
      }),
    }),
  );
}

test.describe("durable review routes", () => {
  test("reloads a friendly route without replacing it with a path query", async ({
    page,
  }) => {
    const statusGate = Promise.withResolvers<void>();
    await mockLocalReviewApi(page, statusGate.promise);
    try {
      await Promise.all([
        page.waitForRequest("**/api/reviews/resolve?**"),
        page.goto(routeRecord.route),
      ]);
      logE2eEvent("review-route.requested-while-status-pending");
    } finally {
      statusGate.resolve();
    }
    await expect(page.getByTestId("rich-text-editor")).toContainText(
      "A readable review route.",
    );
    expect(new URL(page.url()).pathname).toBe(routeRecord.route);
    expect(new URL(page.url()).search).toBe("");
    await expect(page).toHaveTitle("Atlas / Launch plan");

    await page.reload();
    await expect(page.getByTestId("rich-text-editor")).toContainText(
      "A readable review route.",
    );
    expect(new URL(page.url()).pathname).toBe(routeRecord.route);
  });

  test("shows pending reviews on the home list and follows the keyboard link", async ({
    page,
  }) => {
    const statusGate = Promise.withResolvers<void>();
    await mockLocalReviewApi(page, statusGate.promise);
    const reviewLink = page.getByTestId("review-home-item");
    try {
      await page.goto("/");
      await expect(reviewLink).toContainText("Launch plan");
      logE2eEvent("review-home.loaded-while-status-pending");
    } finally {
      statusGate.resolve();
    }
    await expect(reviewLink).toContainText("Atlas");
    await expect(reviewLink).toContainText("Launch plan");
    await expect(reviewLink).toContainText("Waiting");
    await reviewLink.focus();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/atlas\/launch-plan$/);
    await expect(page.getByTestId("rich-text-editor")).toContainText(
      "A readable review route.",
    );
  });
});
