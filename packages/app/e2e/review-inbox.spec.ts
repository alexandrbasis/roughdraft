import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import type { ReviewRouteRecord } from "../src/review-home/review-route";
import { logE2eEvent } from "./helpers";

function reviewFixtures(): ReviewRouteRecord[] {
  // Interleave statuses so retaining API order within each group is observable.
  return Array.from({ length: 25 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    const pending = index % 2 === 0;
    return {
      id: `review_inbox_${number}`,
      route: `/atlas/review-${number}`,
      documentPath: `/tmp/atlas/plans/review-${number}.md`,
      projectPath: "/tmp/atlas",
      relativePath: `plans/review-${number}.md`,
      projectName: "Atlas",
      title: `Review ${number}`,
      status: pending ? "pending" : "completed",
      watcherCount: pending ? 1 : 0,
      waiting: pending,
      reviewed: !pending,
    };
  });
}

async function mockReviewReads(page: Page, initial: ReviewRouteRecord[]) {
  let records = initial;
  for (const [endpoint, payload] of [
    ["status", { backend: "local-files", projectDir: "/tmp", stateless: true }],
    ["update-status", null],
  ] as const) {
    await page.route(`**/api/${endpoint}`, (route) => {
      expect(route.request().method()).toBe("GET");
      return route.fulfill({ json: payload });
    });
  }
  await page.route("**/api/reviews", (route) => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill({ json: records });
  });
  return (next: ReviewRouteRecord[]) => {
    records = next;
  };
}

async function expectItems(page: Page, records: ReviewRouteRecord[]) {
  const items = page.getByTestId("review-home-item");
  await expect(items).toHaveCount(records.length);
  await expect
    .poll(() =>
      items.evaluateAll((links) =>
        links.map((link) => link.getAttribute("href")),
      ),
    )
    .toEqual(records.map((record) => record.route));
}

async function expectQuery(page: Page, status = "all", pageNumber = 1) {
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/" &&
      url.searchParams.get("source") === "inbox regression" &&
      url.searchParams.get("reviewStatus") ===
        (status === "all" ? null : status) &&
      url.searchParams.get("reviewPage") ===
        (pageNumber === 1 ? null : String(pageNumber)),
  );
}

async function expectFilter(page: Page, selected: string, counts: number[]) {
  for (const [index, status] of ["all", "pending", "completed"].entries()) {
    const button = page.getByTestId(`review-filter-${status}`);
    await expect(button).toHaveText(
      new RegExp(
        `^${["All", "Waiting", "Reviewed"][index]}\\s*${counts[index]}$`,
      ),
    );
    await expect(button).toHaveAttribute(
      "aria-pressed",
      String(status === selected),
    );
  }
}

async function captureInbox(page: Page, size: "desktop" | "mobile") {
  await page.getByTestId("review-home").screenshot({
    path: fileURLToPath(
      new URL(
        `../../../.context/ui-state-screenshots/review-inbox-${size}.png`,
        import.meta.url,
      ),
    ),
    animations: "disabled",
  });
}

test.describe("review inbox", () => {
  test("pages stable review links and restores filters without adding history entries", async ({
    page,
  }) => {
    const records = reviewFixtures();
    const pending = records.filter((record) => record.status === "pending");
    const completed = records.filter((record) => record.status === "completed");
    const ordered = [...pending, ...completed];
    await mockReviewReads(page, records);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/?source=inbox+regression");
    await expectFilter(page, "all", [25, 13, 12]);
    const historyLength = await page.evaluate(() => history.length);
    const next = page.getByTestId("review-page-next");
    const previous = page.getByTestId("review-page-previous");

    await test.step("all reviews occupy pages of 10, 10, and 5", async () => {
      for (let pageNumber = 1; pageNumber <= 3; pageNumber++) {
        await expectItems(
          page,
          ordered.slice((pageNumber - 1) * 10, pageNumber * 10),
        );
        await expect(page.getByTestId("review-page-summary")).toHaveText(
          `${(pageNumber - 1) * 10 + 1}–${Math.min(pageNumber * 10, 25)} of 25`,
        );
        await expect(page.getByTestId("review-page-position")).toHaveText(
          `Page ${pageNumber} of 3`,
        );
        await expectQuery(page, "all", pageNumber);
        if (pageNumber === 1) {
          await expect(previous).toBeDisabled();
          await captureInbox(page, "desktop");
        }
        if (pageNumber < 3) {
          await next.focus();
          await page.keyboard.press("Enter");
          await expect(page.getByTestId("review-home-heading")).toBeFocused();
        }
      }
      await expect(next).toBeDisabled();
      await previous.focus();
      await page.keyboard.press("Enter");
      await expectItems(page, ordered.slice(10, 20));
      await expectQuery(page, "all", 2);
    });

    await test.step("keyboard filtering resets the page and reload restores the URL state", async () => {
      await page.getByTestId("review-filter-pending").focus();
      await page.keyboard.press("Space");
      await expectFilter(page, "pending", [25, 13, 12]);
      await expect(page.getByTestId("review-filter-pending")).toBeFocused();
      await expectQuery(page, "pending");
      await expectItems(page, pending.slice(0, 10));
      await next.click();
      await expectItems(page, pending.slice(10));
      await expectQuery(page, "pending", 2);
      await page.reload();
      await expectFilter(page, "pending", [25, 13, 12]);
      await expectItems(page, pending.slice(10));
      await expect(page.getByTestId("review-page-position")).toHaveText(
        "Page 2 of 2",
      );
      await expectQuery(page, "pending", 2);

      await page.getByTestId("review-filter-completed").click();
      await expectFilter(page, "completed", [25, 13, 12]);
      await expectQuery(page, "completed");
      await expectItems(page, completed.slice(0, 10));
      await next.click();
      await expectItems(page, completed.slice(10));
      await expectQuery(page, "completed", 2);
      await page.getByTestId("review-filter-all").click();
      await expectFilter(page, "all", [25, 13, 12]);
      await expectQuery(page);
      await expectItems(page, ordered.slice(0, 10));
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
    });
    logE2eEvent("review-inbox.paging-and-url", {
      pages: [10, 10, 5],
      reloadRestored: true,
      historyLength,
    });
  });

  test("clamps a shrinking polled list and keeps an empty filter usable at 375px", async ({
    page,
  }) => {
    const records = reviewFixtures();
    const pending = records.filter((record) => record.status === "pending");
    const completed = records.filter((record) => record.status === "completed");
    const replaceRecords = await mockReviewReads(page, records);
    await page.setViewportSize({ width: 375, height: 812 });
    // Advance the real polling timer explicitly; no wall-clock sleep or UI state injection.
    const now = new Date("2026-09-08T12:00:00Z");
    await page.clock.install({ time: now });
    await page.clock.pauseAt(now);
    await page.goto("/?source=inbox+regression&reviewPage=3");
    await expectItems(page, completed.slice(7));
    await expect(page.getByTestId("review-page-position")).toHaveText(
      "Page 3 of 3",
    );

    replaceRecords(pending);
    await page.clock.fastForward(5_000);
    await expectFilter(page, "all", [13, 13, 0]);
    await expectItems(page, pending.slice(10));
    await expect(page.getByTestId("review-page-summary")).toHaveText(
      "11–13 of 13",
    );
    await expect(page.getByTestId("review-page-position")).toHaveText(
      "Page 2 of 2",
    );
    await expect(page.getByTestId("review-page-next")).toBeDisabled();
    await expectQuery(page, "all", 2);

    await page.getByTestId("review-filter-completed").focus();
    await page.keyboard.press("Enter");
    await expectFilter(page, "completed", [13, 13, 0]);
    await expect(page.getByTestId("review-filter-completed")).toBeFocused();
    await expectQuery(page, "completed");
    await expect(page.getByTestId("review-filter-empty")).toBeVisible();
    await expectItems(page, []);
    await page.getByTestId("review-filter-all").click();
    await expectItems(page, pending.slice(0, 10));
    await expect(page.getByTestId("review-filter-empty")).toHaveCount(0);
    await expectQuery(page);

    const widths = await page
      .getByTestId("review-home")
      .evaluate((element) => ({
        inbox: element.scrollWidth,
        inboxViewport: element.clientWidth,
        document: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }));
    expect(widths.inbox).toBeLessThanOrEqual(widths.inboxViewport + 1);
    expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
    await captureInbox(page, "mobile");
    logE2eEvent("review-inbox.poll-clamp-and-mobile", {
      before: 25,
      after: 13,
      clampedPage: 2,
      emptyFilter: true,
      widths,
    });
  });
});
