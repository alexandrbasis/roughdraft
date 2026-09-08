import { isFriendlyReviewRoutePath } from "../app-navigation";

export interface ReviewRouteRecord {
  id: string;
  route: string;
  documentPath: string;
  projectPath: string;
  relativePath: string;
  projectName: string;
  title: string;
  status: "pending" | "completed";
  watcherCount: number;
  waiting: boolean;
  reviewed: boolean;
}

export function getFriendlyReviewRouteFromLocation(
  location: Pick<Location, "pathname" | "search"> = window.location,
): string | null {
  const searchParams = new URLSearchParams(location.search);
  if (searchParams.has("path") || searchParams.has("session")) return null;

  let pathname: string;
  try {
    pathname = decodeURIComponent(location.pathname);
  } catch {
    return null;
  }

  if (!isFriendlyReviewRoutePath(pathname)) {
    return null;
  }

  return pathname;
}

export async function resolveReviewRoute(
  route: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReviewRouteRecord | null> {
  const url = new URL("/api/reviews/resolve", window.location.origin);
  url.searchParams.set("route", route);
  const response = await fetchImpl(`${url.pathname}${url.search}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to resolve review route: ${response.status}`);
  }
  return (await response.json()) as ReviewRouteRecord;
}

export function reviewRouteHref(route: string): string {
  return route;
}
