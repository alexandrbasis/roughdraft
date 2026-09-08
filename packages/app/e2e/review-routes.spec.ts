import { expect, test } from "@playwright/test";

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

async function mockLocalReviewApi(page: import("@playwright/test").Page) {
  await page.route("**/api/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        backend: "local-files",
        projectDir: "/tmp",
        stateless: true,
        capabilities: { remoteDocuments: true },
      }),
    }),
  );
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
    await mockLocalReviewApi(page);

    await page.goto(routeRecord.route);
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
    await mockLocalReviewApi(page);

    await page.goto("/");
    const reviewLink = page.getByTestId("review-home-item");
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
