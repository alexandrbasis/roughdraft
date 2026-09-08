import type { Express, Request, Response } from "express";
import {
  type ReviewRegistry,
  ReviewRegistryError,
  type ReviewRecord,
} from "./review-registry.js";

export type ReviewWatcherCount = (
  documentPath: string,
) => number | Promise<number>;

export type ReviewLatestSequence = () => number;

export interface ReviewRouteResponse extends ReviewRecord {
  watcherCount: number;
  waiting: boolean;
  reviewed: boolean;
}

export interface ReviewRegisterResponse extends ReviewRouteResponse {
  afterSequence: number;
}

function sendRegistryError(res: Response, error: unknown): void {
  if (error instanceof ReviewRegistryError) {
    res
      .status(error.statusCode)
      .json({ error: error.message, code: error.code });
    return;
  }

  console.error("Review registry route failed:", error);
  res.status(500).json({ error: "Review registry unavailable" });
}

async function responseFor(
  record: ReviewRecord,
  watcherCount: ReviewWatcherCount,
): Promise<ReviewRouteResponse> {
  const count = await watcherCount(record.documentPath);
  const normalizedCount =
    Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
  return {
    ...record,
    watcherCount: normalizedCount,
    waiting: record.status === "pending",
    reviewed: record.status === "completed",
  };
}

function normalizeSequence(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Install the durable review registry API without coupling it to the server's
 * larger route module. The parent server supplies its watcher count lookup.
 */
export function installReviewRoutes(
  app: Express,
  registry: ReviewRegistry,
  watcherCount: ReviewWatcherCount = () => 0,
  latestSequence: ReviewLatestSequence = () => 0,
): void {
  app.get("/api/reviews", async (_req, res) => {
    try {
      const records = await Promise.all(
        registry.list().map((record) => responseFor(record, watcherCount)),
      );
      res.json(records);
    } catch (error) {
      sendRegistryError(res, error);
    }
  });

  app.post("/api/reviews", async (req: Request, res: Response) => {
    try {
      const documentPath = req.body?.documentPath;
      if (
        typeof documentPath !== "string" ||
        documentPath.trim().length === 0
      ) {
        res.status(400).json({
          error: "documentPath is required",
          code: "INVALID_DOCUMENT_PATH",
        });
        return;
      }

      const afterSequence = normalizeSequence(latestSequence());
      const record = registry.register(documentPath, {
        afterSequence,
        projectName:
          typeof req.body?.projectName === "string"
            ? req.body.projectName
            : undefined,
        title: typeof req.body?.title === "string" ? req.body.title : undefined,
      });
      const response: ReviewRegisterResponse = {
        ...(await responseFor(record, watcherCount)),
        afterSequence,
      };
      res.status(201).json(response);
    } catch (error) {
      sendRegistryError(res, error);
    }
  });

  // Keep this exact route before any future /api/reviews/:id route. A raw slug
  // never becomes a filesystem path; it must match a persisted registry record.
  // Resolving a link is read-only: only POST /api/reviews represents a new
  // opening and moves a completed record back to pending.
  app.get("/api/reviews/resolve", async (req: Request, res: Response) => {
    try {
      const route = typeof req.query.route === "string" ? req.query.route : "";
      const record = registry.getByRoute(route);
      if (!record) {
        res
          .status(404)
          .json({ error: "Review route not found", code: "REVIEW_NOT_FOUND" });
        return;
      }
      res.json(await responseFor(record, watcherCount));
    } catch (error) {
      sendRegistryError(res, error);
    }
  });
}
