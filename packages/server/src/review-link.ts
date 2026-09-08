import { readPublicBaseUrl, verifyPublicBaseUrl } from "./local-domain.js";
import { validateReviewRoute } from "./review-registry.js";

export async function registerReviewLink(options: {
  apiUrl: string;
  documentPath: string;
  env: NodeJS.ProcessEnv;
  serverRoot: string;
  port: number;
  fetchImpl: typeof fetch;
  usePublicUrl?: boolean;
}): Promise<{ url?: string; afterSequence?: number }> {
  const publicUrl =
    options.usePublicUrl === false ? null : readPublicBaseUrl(options.env);
  if (publicUrl) {
    await verifyPublicBaseUrl(publicUrl, options, options.fetchImpl);
  }
  const response = await options.fetchImpl(
    new URL("/api/reviews", options.apiUrl),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentPath: options.documentPath }),
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status === 404 && !publicUrl) return {};
  if (!response.ok) {
    throw new Error(`Could not register review: HTTP ${response.status}.`);
  }
  const record = (await response.json()) as {
    route: string;
    afterSequence?: number;
  };
  const route = validateReviewRoute(record.route);
  const afterSequence = record.afterSequence;
  if (
    afterSequence !== undefined &&
    (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
  ) {
    throw new Error("Review registration returned an invalid event cursor.");
  }
  return {
    url: publicUrl ? new URL(route, publicUrl).toString() : undefined,
    afterSequence,
  };
}
