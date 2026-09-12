import {
  ArrowUpRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileText,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { ReviewHistory } from "./ReviewHistory";
import { type ReviewRouteRecord, reviewRouteHref } from "./review-route";

const PAGE_SIZE = 10;
const REVIEW_FILTERS = [
  { value: "all", label: "All" },
  { value: "pending", label: "Waiting" },
  { value: "completed", label: "Reviewed" },
] as const;
type ReviewFilter = (typeof REVIEW_FILTERS)[number]["value"];

function readInboxLocation(): { status: ReviewFilter; page: number } {
  const query = new URLSearchParams(window.location.search);
  const status = query.get("reviewStatus");
  const page = Number(query.get("reviewPage") ?? 1);
  return {
    status: status === "pending" || status === "completed" ? status : "all",
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

async function loadReviews(): Promise<ReviewRouteRecord[]> {
  const response = await fetch("/api/reviews");
  if (!response.ok)
    throw new Error(`Failed to load reviews: ${response.status}`);
  const payload = (await response.json()) as unknown;
  return Array.isArray(payload) ? (payload as ReviewRouteRecord[]) : [];
}

function watcherLabel(count: number): string {
  if (count === 1) return "1 agent watching";
  if (count > 1) return `${count} agents watching`;
  return "No agent watching";
}

export function ReviewHome({
  reviewHistorySupported = false,
}: {
  reviewHistorySupported?: boolean;
} = {}) {
  const [reviews, setReviews] = useState<ReviewRouteRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reviewsRef = useRef<ReviewRouteRecord[] | null>(null);
  const mountedRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [selection, setSelection] = useState(readInboxLocation);
  const counts = {
    all: reviews?.length ?? 0,
    pending:
      reviews?.filter((review) => review.status === "pending").length ?? 0,
    completed:
      reviews?.filter((review) => review.status === "completed").length ?? 0,
  };
  const filteredReviews = (reviews ?? [])
    .filter(
      (review) =>
        selection.status === "all" || review.status === selection.status,
    )
    .sort(
      (left, right) =>
        Number(right.status === "pending") - Number(left.status === "pending"),
    );
  const pageCount = Math.max(1, Math.ceil(filteredReviews.length / PAGE_SIZE));
  const page = reviews ? Math.min(selection.page, pageCount) : selection.page;
  const firstIndex = (page - 1) * PAGE_SIZE;
  const pageReviews = filteredReviews.slice(firstIndex, firstIndex + PAGE_SIZE);

  useEffect(() => {
    const readLocation = () => setSelection(readInboxLocation());
    window.addEventListener("popstate", readLocation);
    return () => window.removeEventListener("popstate", readLocation);
  }, []);

  useEffect(() => {
    if (!reviews) return;
    // Polling can remove the last page; clamp instead of displaying an empty one.
    if (selection.page !== page)
      setSelection((current) => ({ ...current, page }));
    const url = new URL(window.location.href);
    if (selection.status === "all") url.searchParams.delete("reviewStatus");
    else url.searchParams.set("reviewStatus", selection.status);
    if (page === 1) url.searchParams.delete("reviewPage");
    else url.searchParams.set("reviewPage", String(page));
    if (url.href !== window.location.href)
      window.history.replaceState(window.history.state, "", url);
  }, [reviews, selection.status, selection.page, page]);

  const changePage = (nextPage: number) => {
    setSelection((current) => ({ ...current, page: nextPage }));
    headingRef.current?.focus();
    headingRef.current?.scrollIntoView({ block: "start" });
  };

  const refreshReviews = useCallback(async () => {
    if (!mountedRef.current) return;
    if (!reviewsRef.current) setLoading(true);

    try {
      const nextReviews = await loadReviews();
      if (!mountedRef.current) return;
      reviewsRef.current = nextReviews;
      setReviews(nextReviews);
      setError(null);
    } catch {
      if (!mountedRef.current) return;
      setError("Could not load reviews.");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    // The preview-web build intentionally has no review registry API.
    if (
      typeof fetch !== "function" ||
      import.meta.env.VITE_PREVIEW_WEB === "1"
    ) {
      setLoading(false);
      return;
    }

    const refreshIfVisible = () => {
      if (document.visibilityState === "hidden") return;
      void refreshReviews();
    };

    void refreshReviews();
    const interval = window.setInterval(refreshIfVisible, 5_000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshIfVisible();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", refreshIfVisible);

    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", refreshIfVisible);
    };
  }, [refreshReviews]);

  if (loading && !reviews) {
    return (
      <section
        aria-live="polite"
        className="mx-auto mb-10 w-full max-w-[1500px] text-left"
        data-testid="review-home-status"
      >
        <p className="text-sm text-stone-500 dark:text-stone-400">
          Loading reviews…
        </p>
      </section>
    );
  }

  if (!reviews && error) {
    return (
      <section
        aria-live="polite"
        className="mx-auto mb-10 flex w-full max-w-[1500px] flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-left dark:border-rose-900/70 dark:bg-rose-950/30"
        data-testid="review-home-status"
        role="alert"
      >
        <p className="text-sm text-rose-800 dark:text-rose-200">{error}</p>
        <Button
          className="h-8 gap-1.5 px-2.5 text-xs"
          data-testid="review-home-retry"
          onClick={() => void refreshReviews()}
          size="sm"
          variant="outline"
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
          Retry
        </Button>
      </section>
    );
  }

  if (!reviews || reviews.length === 0) {
    if (!error) return null;

    return (
      <section
        aria-live="polite"
        className="mx-auto mb-10 flex w-full max-w-[1500px] flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-left dark:border-rose-900/70 dark:bg-rose-950/30"
        data-testid="review-home-status"
        role="alert"
      >
        <p className="text-sm text-rose-800 dark:text-rose-200">{error}</p>
        <Button
          className="h-8 gap-1.5 px-2.5 text-xs"
          data-testid="review-home-retry"
          onClick={() => void refreshReviews()}
          size="sm"
          variant="outline"
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
          Retry
        </Button>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="review-home-heading"
      className="mx-auto mb-16 w-full max-w-[1500px] text-left"
      data-testid="review-home"
    >
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-4 dark:border-slate-700">
        <div>
          <p className="text-xs font-semibold tracking-[0.16em] text-stone-500 uppercase dark:text-stone-400">
            Review inbox
          </p>
          <h2
            className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-slate-950 dark:text-slate-50 sm:text-4xl"
            data-testid="review-home-heading"
            ref={headingRef}
            tabIndex={-1}
            id="review-home-heading"
          >
            Pick up where the agent left off
          </h2>
        </div>
        <p className="max-w-sm text-sm leading-6 text-stone-500 dark:text-stone-400">
          Open a review by its readable link. Pending reviews stay at the top;
          completed reviews remain available for context.
        </p>
      </div>

      {error ? (
        <div
          className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900/70 dark:bg-rose-950/30 dark:text-rose-200"
          data-testid="review-home-refresh-error"
          role="alert"
        >
          <span>{error} Showing the last successful list.</span>
          <Button
            className="h-7 gap-1.5 px-2 text-xs"
            data-testid="review-home-retry"
            onClick={() => void refreshReviews()}
            size="sm"
            variant="outline"
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Retry
          </Button>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          aria-label="Filter reviews by status"
          className="flex flex-wrap gap-1 rounded-lg bg-stone-100 p-1 dark:bg-slate-800"
        >
          {REVIEW_FILTERS.map(({ value, label }) => (
            <Button
              key={value}
              data-testid={`review-filter-${value}`}
              aria-pressed={selection.status === value}
              variant="ghost"
              className={`h-9 gap-2 px-3 text-sm transition-colors ${selection.status === value ? "bg-white text-slate-950 shadow-sm hover:bg-white dark:bg-slate-700 dark:text-white dark:hover:bg-slate-700" : "text-stone-500 dark:text-stone-400"}`}
              onClick={() => setSelection({ status: value, page: 1 })}
            >
              {label}
              <span className="text-xs tabular-nums opacity-70">
                {counts[value]}
              </span>
            </Button>
          ))}
        </div>
        <p
          data-testid="review-page-summary"
          className="text-xs tabular-nums text-stone-500 dark:text-stone-400"
        >
          {filteredReviews.length
            ? `${firstIndex + 1}–${Math.min(firstIndex + PAGE_SIZE, filteredReviews.length)} of ${filteredReviews.length}`
            : "0 reviews"}
        </p>
      </div>
      {filteredReviews.length === 0 ? (
        <div
          data-testid="review-filter-empty"
          className="mt-4 rounded-xl border border-dashed border-slate-200 px-5 py-10 text-center dark:border-slate-700"
        >
          <p
            role="status"
            className="text-sm text-stone-500 dark:text-stone-400"
          >
            {selection.status === "pending"
              ? "No reviews waiting for you."
              : "No completed reviews yet."}
          </p>
          <Button
            data-testid="review-filter-reset"
            variant="outline"
            className="mt-3"
            onClick={() => setSelection({ status: "all", page: 1 })}
          >
            Show all reviews
          </Button>
        </div>
      ) : null}
      <div
        className="mt-4 grid grid-cols-1 gap-3"
        data-testid="review-home-list"
      >
        {pageReviews.map((review) => {
          const pending = review.status === "pending";
          return (
            <div
              key={review.id}
              data-testid="review-home-card"
              className="rounded-xl border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.05)] dark:border-slate-700 dark:bg-slate-900"
            >
              <a
                className="group block rounded-xl p-5 transition-colors hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-slate-950 focus-visible:ring-offset-2 focus-visible:outline-none dark:hover:bg-slate-800 dark:focus-visible:ring-slate-50 dark:focus-visible:ring-offset-slate-950"
                data-testid="review-home-item"
                href={reviewRouteHref(review.route)}
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs font-semibold tracking-[0.12em] text-stone-500 uppercase dark:text-stone-400">
                      <FileText
                        className="size-4 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="truncate">{review.projectName}</span>
                    </div>
                    <h3 className="mt-2 truncate text-xl font-semibold text-slate-950 dark:text-slate-50">
                      {review.title}
                    </h3>
                    <p className="mt-1 truncate font-mono text-xs text-stone-500 dark:text-stone-400">
                      {review.route}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2 text-sm font-medium">
                    {pending ? (
                      <Clock3
                        className="size-4 text-amber-600 dark:text-amber-400"
                        aria-hidden="true"
                      />
                    ) : (
                      <CheckCircle2
                        className="size-4 text-emerald-600 dark:text-emerald-400"
                        aria-hidden="true"
                      />
                    )}
                    <span
                      className={
                        pending
                          ? "text-amber-800 dark:text-amber-300"
                          : "text-emerald-800 dark:text-emerald-300"
                      }
                    >
                      {pending ? "Waiting" : "Reviewed"}
                    </span>
                    <ArrowUpRight
                      className="size-4 text-stone-400 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 dark:text-stone-500"
                      aria-hidden="true"
                    />
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                  <span>
                    {pending ? "Waiting for your review" : "Review completed"}
                  </span>
                  <span>{watcherLabel(review.watcherCount)}</span>
                </div>
              </a>
              {reviewHistorySupported && review.documentPath ? (
                <ReviewHistory
                  documentPath={review.documentPath}
                  title={review.title}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      {pageCount > 1 ? (
        <nav
          aria-label="Review pages"
          className="mt-5 flex flex-wrap items-center justify-between gap-3"
        >
          <p
            data-testid="review-page-position"
            role="status"
            className="text-xs tabular-nums text-stone-500 dark:text-stone-400"
          >
            Page {page} of {pageCount}
          </p>
          <div className="flex gap-2">
            <Button
              data-testid="review-page-previous"
              variant="outline"
              className="h-9 gap-1.5 px-3"
              disabled={page === 1}
              onClick={() => changePage(page - 1)}
            >
              <ChevronLeft aria-hidden="true" /> Previous
            </Button>
            <Button
              data-testid="review-page-next"
              variant="outline"
              className="h-9 gap-1.5 px-3"
              disabled={page === pageCount}
              onClick={() => changePage(page + 1)}
            >
              Next <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        </nav>
      ) : null}
    </section>
  );
}
