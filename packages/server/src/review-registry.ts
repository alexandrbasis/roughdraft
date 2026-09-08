import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runtimeStateDirectory } from "./local-domain.js";

export type ReviewStatus = "pending" | "completed";

export interface ReviewRecord {
  id: string;
  route: string;
  documentPath: string;
  projectPath: string;
  relativePath: string;
  projectName: string;
  title: string;
  status: ReviewStatus;
  openedAt: string;
  openedAfterSequence?: number;
  completedAt?: string;
  completionEvent?: unknown;
}

export interface ReviewRegisterOptions {
  afterSequence?: number;
  projectName?: string;
  title?: string;
}

export interface ReviewRegistryOptions {
  storePath?: string | null;
  stateDir?: string;
  memory?: boolean;
  now?: () => Date;
}

interface PersistedRegistry {
  version: 1;
  records: ReviewRecord[];
}

export class ReviewRegistryError extends Error {
  readonly statusCode: 400 | 404 | 409;
  readonly code: string;

  constructor(
    message: string,
    code: string,
    statusCode: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "ReviewRegistryError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function defaultStorePath(): string {
  return path.join(runtimeStateDirectory(), "review-registry.json");
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    // Leave room for the deterministic collision suffix while keeping the
    // complete route segment within the validation limit.
    .slice(0, 56);
  return slug || fallback;
}

function isValidRouteSegment(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,70}[a-z0-9])?$/.test(value);
}

export function validateReviewRoute(route: string): string {
  if (typeof route !== "string" || !route.startsWith("/")) {
    throw new ReviewRegistryError("route must start with /", "INVALID_ROUTE");
  }

  const segments = route.split("/").slice(1);
  if (
    segments.length !== 2 ||
    segments.some((segment) => !isValidRouteSegment(segment))
  ) {
    throw new ReviewRegistryError(
      "route must contain exactly two safe name segments",
      "INVALID_ROUTE",
    );
  }

  return `/${segments.join("/")}`;
}

function canonicalDocumentPath(documentPath: string): string {
  const suppliedPath = asNonEmptyString(documentPath);
  if (!suppliedPath) {
    throw new ReviewRegistryError(
      "documentPath is required",
      "INVALID_DOCUMENT_PATH",
    );
  }

  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync.native(path.resolve(suppliedPath));
  } catch {
    throw new ReviewRegistryError(
      "Markdown file not found",
      "DOCUMENT_NOT_FOUND",
      404,
    );
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(canonicalPath);
  } catch {
    throw new ReviewRegistryError(
      "Markdown file not found",
      "DOCUMENT_NOT_FOUND",
      404,
    );
  }

  if (!stats.isFile() || !canonicalPath.toLowerCase().endsWith(".md")) {
    throw new ReviewRegistryError(
      "documentPath must point to a Markdown file",
      "INVALID_DOCUMENT_PATH",
    );
  }

  return canonicalPath;
}

function hasProjectMarker(directory: string): boolean {
  return [".git", "package.json"].some((name) =>
    fs.existsSync(path.join(directory, name)),
  );
}

function findProjectRoot(documentPath: string): string {
  let directory = path.dirname(documentPath);
  while (true) {
    if (hasProjectMarker(directory)) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return path.dirname(documentPath);
}

function projectNameFromRoot(projectRoot: string): string {
  const packagePath = path.join(projectRoot, "package.json");
  try {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf-8")) as {
      name?: unknown;
    };
    const packageName = asNonEmptyString(packageJson.name);
    if (packageName) return packageName;
  } catch {
    // A package marker still identifies the project even when its JSON is not
    // readable. Fall back to the directory name below.
  }

  return path.basename(projectRoot) || "project";
}

function titleFromMarkdown(documentPath: string): string {
  const content = fs.readFileSync(documentPath, "utf-8");
  const heading = content.match(/^\s*#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  return heading || path.basename(documentPath, path.extname(documentPath));
}

function recordId(documentPath: string): string {
  return `review_${crypto
    .createHash("sha256")
    .update(documentPath)
    .digest("hex")
    .slice(0, 20)}`;
}

function routeBaseFor(projectName: string, title: string): string {
  return `/${slugify(projectName, "project")}/${slugify(title, "review")}`;
}

function routeForNewRecord(
  baseRoute: string,
  documentPath: string,
  records: ReviewRecord[],
): string {
  const occupied = new Set(records.map((record) => record.route));
  if (!occupied.has(baseRoute)) return baseRoute;

  const hash = crypto.createHash("sha256").update(documentPath).digest("hex");
  const [project, topic] = baseRoute.slice(1).split("/");

  for (const length of [6, 8, 12]) {
    const candidate = `/${project}/${topic}-${hash.slice(0, length)}`;
    if (!occupied.has(candidate)) return candidate;
  }

  let counter = 2;
  while (occupied.has(`/${project}/${topic}-${hash.slice(0, 12)}-${counter}`)) {
    counter += 1;
  }
  return `/${project}/${topic}-${hash.slice(0, 12)}-${counter}`;
}

function cloneRecord(record: ReviewRecord): ReviewRecord {
  return { ...record };
}

export class ReviewRegistry {
  readonly storePath: string | null;

  private readonly now: () => Date;
  private records: ReviewRecord[];

  constructor(storePath?: string | null);
  constructor(options?: ReviewRegistryOptions);
  constructor(input: string | null | ReviewRegistryOptions = {}) {
    const options: ReviewRegistryOptions =
      typeof input === "string" || input === null
        ? { storePath: input }
        : input;
    this.storePath =
      options.memory === true || options.storePath === null
        ? null
        : path.resolve(
            options.storePath ??
              (options.stateDir
                ? path.join(options.stateDir, "review-registry.json")
                : defaultStorePath()),
          );
    this.now = options.now ?? (() => new Date());
    this.records = this.readRecords();
  }

  list(): ReviewRecord[] {
    return this.records.map(cloneRecord);
  }

  getByRoute(route: string): ReviewRecord | null {
    const normalizedRoute = validateReviewRoute(route);
    const record = this.records.find(
      (candidate) => candidate.route === normalizedRoute,
    );
    return record ? cloneRecord(record) : null;
  }

  getByDocumentPath(documentPath: string): ReviewRecord | null {
    const canonicalPath = canonicalDocumentPath(documentPath);
    const record = this.records.find(
      (candidate) => candidate.documentPath === canonicalPath,
    );
    return record ? cloneRecord(record) : null;
  }

  register(
    documentPath: string,
    overrides: ReviewRegisterOptions = {},
  ): ReviewRecord {
    const canonicalPath = canonicalDocumentPath(documentPath);
    const existing = this.records.find(
      (record) => record.documentPath === canonicalPath,
    );
    const now = this.now().toISOString();

    if (existing) {
      const previous = { ...existing };
      existing.status = "pending";
      existing.openedAt = now;
      existing.openedAfterSequence = overrides.afterSequence;
      delete existing.completedAt;
      delete existing.completionEvent;
      try {
        this.persist();
      } catch (error) {
        this.records = this.records.map((record) =>
          record.id === existing.id ? previous : record,
        );
        throw error;
      }
      return cloneRecord(existing);
    }

    const projectPath = findProjectRoot(canonicalPath);
    const projectName =
      asNonEmptyString(overrides.projectName) ??
      projectNameFromRoot(projectPath);
    const title =
      asNonEmptyString(overrides.title) ?? titleFromMarkdown(canonicalPath);
    const baseRoute = routeBaseFor(projectName, title);
    const record: ReviewRecord = {
      id: recordId(canonicalPath),
      route: routeForNewRecord(baseRoute, canonicalPath, this.records),
      documentPath: canonicalPath,
      projectPath,
      relativePath: path
        .relative(projectPath, canonicalPath)
        .split(path.sep)
        .join("/"),
      projectName,
      title,
      status: "pending",
      openedAt: now,
      openedAfterSequence: overrides.afterSequence,
    };

    this.records.push(record);
    try {
      this.persist();
    } catch (error) {
      this.records = this.records.filter((candidate) => candidate !== record);
      throw error;
    }
    return cloneRecord(record);
  }

  openRoute(route: string): ReviewRecord | null {
    const record = this.getByRoute(route);
    if (!record) return null;

    const existing = this.records.find(
      (candidate) => candidate.id === record.id,
    );
    if (!existing) return null;
    const previous = { ...existing };
    existing.status = "pending";
    existing.openedAt = this.now().toISOString();
    delete existing.openedAfterSequence;
    delete existing.completedAt;
    delete existing.completionEvent;
    try {
      this.persist();
    } catch (error) {
      this.records = this.records.map((candidate) =>
        candidate.id === existing.id ? previous : candidate,
      );
      throw error;
    }
    return cloneRecord(existing);
  }

  complete(documentPath: string, event?: unknown): ReviewRecord | null {
    const canonicalPath = canonicalDocumentPath(documentPath);
    const record = this.records.find(
      (candidate) => candidate.documentPath === canonicalPath,
    );
    if (!record) return null;

    const previous = { ...record };
    record.status = "completed";
    record.completedAt = this.now().toISOString();
    if (event !== undefined) record.completionEvent = event;
    else delete record.completionEvent;
    try {
      this.persist();
    } catch (error) {
      this.records = this.records.map((candidate) =>
        candidate.id === record.id ? previous : candidate,
      );
      throw error;
    }
    return cloneRecord(record);
  }

  private readRecords(): ReviewRecord[] {
    if (!this.storePath) return [];
    if (!fs.existsSync(this.storePath)) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.storePath, "utf-8"));
    } catch {
      throw new ReviewRegistryError(
        "Review registry store is not valid JSON",
        "INVALID_STORE",
        409,
      );
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { version?: unknown }).version !== 1 ||
      !Array.isArray((parsed as { records?: unknown }).records)
    ) {
      throw new ReviewRegistryError(
        "Review registry store has an unsupported format",
        "INVALID_STORE",
        409,
      );
    }

    return (parsed as PersistedRegistry).records.map((record) => {
      if (
        !record ||
        typeof record.id !== "string" ||
        typeof record.route !== "string" ||
        typeof record.documentPath !== "string" ||
        (record.status !== "pending" && record.status !== "completed")
      ) {
        throw new ReviewRegistryError(
          "Review registry store contains an invalid record",
          "INVALID_STORE",
          409,
        );
      }
      validateReviewRoute(record.route);
      return { ...record };
    });
  }

  private persist(): void {
    if (!this.storePath) return;
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const temporaryPath = `${this.storePath}.${process.pid}.${Date.now()}.tmp`;
    const payload: PersistedRegistry = { version: 1, records: this.records };
    let descriptor: number | undefined;
    try {
      fs.writeFileSync(
        temporaryPath,
        `${JSON.stringify(payload, null, 2)}\n`,
        "utf-8",
      );
      descriptor = fs.openSync(temporaryPath, "r");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryPath, this.storePath);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporaryPath, { force: true });
    }
  }
}
