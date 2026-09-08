import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { type ReviewDatabase, ReviewDatabaseError } from "./review-database.js";
import { MarkdownConflictError } from "./atomic-markdown.js";

export function installReviewHistoryRoutes(
  app: Express,
  db: ReviewDatabase,
  save: (file: string, content: string, expectedContent: string) => void,
): void {
  function documentPath(value: unknown, existing = false): string {
    if (
      typeof value !== "string" ||
      !path.isAbsolute(value) ||
      !value.toLowerCase().endsWith(".md")
    )
      throw new ReviewDatabaseError(
        "An absolute Markdown documentPath is required.",
        400,
      );
    try {
      const resolved = fs.realpathSync(value);
      if (!fs.statSync(resolved).isFile())
        throw new ReviewDatabaseError("Document must be a regular file.", 400);
      return resolved;
    } catch (error) {
      if (error instanceof ReviewDatabaseError) throw error;
      if (existing) throw new ReviewDatabaseError("Document not found.", 404);
      return path.resolve(value);
    }
  }
  function route(handler: (req: Request, res: Response) => void) {
    return (req: Request, res: Response) => {
      try {
        handler(req, res);
      } catch (error) {
        const status =
          error instanceof ReviewDatabaseError
            ? error.statusCode
            : error instanceof MarkdownConflictError
              ? 409
              : 500;
        res.status(status).json({
          error:
            error instanceof Error
              ? error.message
              : "Review storage unavailable",
        });
      }
    };
  }
  app.get(
    "/api/reviews/history",
    route((req, res) =>
      res.json(db.history(documentPath(req.query.documentPath))),
    ),
  );
  app.get(
    "/api/reviews/drafts",
    route((req, res) => {
      const file = documentPath(req.query.documentPath);
      res.json({ documentPath: file, drafts: db.listDrafts(file) });
    }),
  );
  app.put(
    "/api/reviews/drafts",
    route((req, res) =>
      res.json(
        db.saveDraft(
          documentPath(req.body?.documentPath, true),
          req.body?.draft,
        ),
      ),
    ),
  );
  app.delete(
    "/api/reviews/drafts",
    route((req, res) => {
      const file = documentPath(req.body?.documentPath);
      if (
        typeof req.body?.tabId !== "string" ||
        typeof req.body?.revision !== "string"
      )
        throw new ReviewDatabaseError("tabId and revision are required.", 400);
      res.json({
        deleted: db.deleteDraft(file, req.body.tabId, req.body.revision),
      });
    }),
  );
  app.post(
    "/api/review-events/ack",
    route((req, res) => {
      if (typeof req.body?.consumerId !== "string")
        throw new ReviewDatabaseError("consumerId is required.", 400);
      res.json(
        db.acknowledge(req.body.sequence, req.body.consumerId, req.body.status),
      );
    }),
  );
  app.get(
    "/api/reviews/snapshots/:id",
    route((req, res) => {
      const file = documentPath(req.query.documentPath);
      const snapshot = db.getSnapshot(String(req.params.id), file);
      if (!snapshot) throw new ReviewDatabaseError("Snapshot not found.", 404);
      let currentVersion: string | null = null;
      if (fs.existsSync(file))
        currentVersion = createHash("sha256")
          .update(fs.readFileSync(file))
          .digest("hex");
      res.json({ ...snapshot, currentVersion });
    }),
  );
  app.post(
    "/api/reviews/snapshots/:id/restore",
    route((req, res) => {
      const file = documentPath(req.body?.documentPath, true);
      const snapshot = db.getSnapshot(String(req.params.id), file) as
        | { content: string }
        | undefined;
      if (!snapshot) throw new ReviewDatabaseError("Snapshot not found.", 404);
      const current = fs.readFileSync(file, "utf8");
      const currentVersion = createHash("sha256").update(current).digest("hex");
      if (req.body?.expectedVersion !== currentVersion)
        throw new ReviewDatabaseError(
          "The file changed. Load the snapshot again before restoring.",
        );
      save(file, snapshot.content, current);
      res.json({ restored: true });
    }),
  );
}
