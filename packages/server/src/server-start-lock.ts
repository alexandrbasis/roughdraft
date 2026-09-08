import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const LOCK_OWNER_FILE = "owner.json";
const RECLAIM_CLAIM_PREFIX = ".reclaim-";
const MISSING_OWNER_RECLAIM_KEY = "missing-owner";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 25;
const DEFAULT_STALE_LOCK_AGE_MS = 30_000;

interface ServerStartLockOwner {
  pid: number;
  token: string;
  acquiredAt: string;
}

export interface ServerStartLock {
  path: string;
  token: string;
  release: () => void;
}

export interface AcquireServerStartLockOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  staleLockAgeMs?: number;
  processId?: number;
  isProcessRunning?: (pid: number) => boolean;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
  createToken?: () => string;
}

export function getServerStartLockPath(stateFilePath: string): string {
  return `${stateFilePath}.lock`;
}

function defaultIsProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function ownerFilePath(lockPath: string): string {
  return path.join(lockPath, LOCK_OWNER_FILE);
}

function reclamationClaimPath(lockPath: string, key: string): string {
  const digest = crypto.createHash("sha256").update(key).digest("hex");
  return path.join(lockPath, `${RECLAIM_CLAIM_PREFIX}${digest}`);
}

function hasReclamationClaim(lockPath: string): boolean {
  try {
    return fs
      .readdirSync(lockPath)
      .some((entry) => entry.startsWith(RECLAIM_CLAIM_PREFIX));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function tryClaimReclamation(lockPath: string, key: string): string | null {
  if (hasReclamationClaim(lockPath)) return null;

  const claimPath = reclamationClaimPath(lockPath, key);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(claimPath, "wx", 0o600);
    fs.fsyncSync(descriptor);
    return claimPath;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT") return null;
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function isValidOwner(value: unknown): value is ServerStartLockOwner {
  if (!value || typeof value !== "object") return false;

  const owner = value as Partial<ServerStartLockOwner>;
  return (
    typeof owner.pid === "number" &&
    Number.isInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.token === "string" &&
    owner.token.length > 0 &&
    typeof owner.acquiredAt === "string" &&
    owner.acquiredAt.length > 0
  );
}

function readOwner(lockPath: string): ServerStartLockOwner | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(ownerFilePath(lockPath), "utf8"),
    ) as unknown;
    return isValidOwner(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeOwner(lockPath: string, owner: ServerStartLockOwner): void {
  if (hasReclamationClaim(lockPath)) {
    throw new Error("Roughdraft startup lock is being reclaimed.");
  }

  const ownerPath = ownerFilePath(lockPath);
  const temporaryPath = `${ownerPath}.${owner.token}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    fs.renameSync(temporaryPath, ownerPath);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {}
  }
}

function removeLockIfOwnedBy(
  lockPath: string,
  expectedOwner: ServerStartLockOwner,
): boolean {
  const claimPath = tryClaimReclamation(lockPath, expectedOwner.token);
  if (!claimPath) return false;

  const currentOwner = readOwner(lockPath);
  if (
    !currentOwner ||
    currentOwner.pid !== expectedOwner.pid ||
    currentOwner.token !== expectedOwner.token
  ) {
    return false;
  }

  if (!fs.existsSync(claimPath)) return false;

  const confirmedOwner = readOwner(lockPath);
  if (
    !confirmedOwner ||
    confirmedOwner.pid !== expectedOwner.pid ||
    confirmedOwner.token !== expectedOwner.token
  ) {
    return false;
  }

  try {
    fs.rmSync(lockPath, { recursive: true, force: false });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function removeLockForStaleOwner(
  lockPath: string,
  owner: ServerStartLockOwner,
  isProcessRunning: (pid: number) => boolean,
): boolean {
  if (isProcessRunning(owner.pid)) return false;
  return removeLockIfOwnedBy(lockPath, owner);
}

function removeLockWithMissingOwner(
  lockPath: string,
  staleLockAgeMs: number,
  now: () => number,
): boolean {
  try {
    const ageMs = now() - fs.statSync(lockPath).mtimeMs;
    if (ageMs < staleLockAgeMs) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  const claimPath = tryClaimReclamation(lockPath, MISSING_OWNER_RECLAIM_KEY);
  if (!claimPath) return false;

  if (fs.existsSync(ownerFilePath(lockPath))) return false;

  if (!fs.existsSync(claimPath)) return false;
  if (fs.existsSync(ownerFilePath(lockPath))) return false;

  try {
    fs.rmSync(lockPath, { recursive: true, force: false });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function releaseServerStartLock(lock: {
  path: string;
  owner: ServerStartLockOwner;
}): void {
  removeLockIfOwnedBy(lock.path, lock.owner);
}

export async function acquireServerStartLock(
  lockPath: string,
  options: AcquireServerStartLockOptions = {},
): Promise<ServerStartLock> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const staleLockAgeMs = options.staleLockAgeMs ?? DEFAULT_STALE_LOCK_AGE_MS;
  const processId = options.processId ?? process.pid;
  const isProcessRunning = options.isProcessRunning ?? defaultIsProcessRunning;
  const sleepImpl = options.sleepImpl ?? ((ms: number) => sleep(ms));
  const now = options.now ?? Date.now;
  const createToken = options.createToken ?? crypto.randomUUID;
  const token = createToken();
  const owner: ServerStartLockOwner = {
    pid: processId,
    token,
    acquiredAt: new Date(now()).toISOString(),
  };
  const absoluteLockPath = path.resolve(lockPath);
  const deadline = now() + timeoutMs;

  fs.mkdirSync(path.dirname(absoluteLockPath), { recursive: true });

  while (true) {
    try {
      fs.mkdirSync(absoluteLockPath);
      writeOwner(absoluteLockPath, owner);

      return {
        path: absoluteLockPath,
        token,
        release: () =>
          releaseServerStartLock({ path: absoluteLockPath, owner }),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
    }

    const existingOwner = readOwner(absoluteLockPath);
    if (existingOwner) {
      removeLockForStaleOwner(
        absoluteLockPath,
        existingOwner,
        isProcessRunning,
      );
    } else {
      removeLockWithMissingOwner(absoluteLockPath, staleLockAgeMs, now);
    }

    if (now() >= deadline) {
      throw new Error(
        `Timed out waiting for Roughdraft startup lock: ${absoluteLockPath}`,
      );
    }

    await sleepImpl(Math.min(retryDelayMs, Math.max(1, deadline - now())));
  }
}
