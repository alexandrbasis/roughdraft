import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class MarkdownConflictError extends Error {
  readonly code = "MARKDOWN_CONFLICT";

  constructor(readonly filePath: string) {
    super(`Markdown changed before it could be saved: ${filePath}`);
    this.name = "MarkdownConflictError";
  }
}

function readRegularFile(filePath: string): { bytes: Buffer; stat: fs.Stats } {
  // NONBLOCK prevents a raced-in FIFO from hanging before fstat can reject it.
  const fd = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${filePath}`);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (
      stat.size !== after.size ||
      stat.mtimeMs !== after.mtimeMs ||
      stat.ctimeMs !== after.ctimeMs
    ) {
      throw new MarkdownConflictError(filePath);
    }
    return { bytes, stat };
  } finally {
    fs.closeSync(fd);
  }
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
  );
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function removeTemporary(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function stageFile(directory: string, bytes: Buffer, stat?: fs.Stats): string {
  const temporaryPath = path.join(directory, `.roughdraft-${randomUUID()}.tmp`);
  const fd = fs.openSync(temporaryPath, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, bytes);
      if (stat) {
        const staged = fs.fstatSync(fd);
        // Fail before replacement if we cannot retain the owner's uid/gid.
        if (staged.uid !== stat.uid || staged.gid !== stat.gid) {
          fs.fchownSync(fd, stat.uid, stat.gid);
        }
        // chown and writes may clear special mode bits, so chmod comes last.
        fs.fchmodSync(fd, stat.mode & 0o7777);
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return temporaryPath;
  } catch (error) {
    removeTemporary(temporaryPath);
    throw error;
  }
}

function preserveBackup(
  directory: string,
  bytes: Buffer,
  target: string,
): string {
  const firstCreated = fs.mkdirSync(directory, {
    recursive: true,
    mode: 0o700,
  });
  const canonicalDirectory = fs.realpathSync(directory);
  // Persist newly created directory entries, including any intermediate parents.
  if (firstCreated) {
    const stop = path.dirname(fs.realpathSync(firstCreated));
    let current = canonicalDirectory;
    while (current !== stop) {
      syncDirectory(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    syncDirectory(stop);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const backupPath = path.join(canonicalDirectory, `${digest}.md`);
  if (backupPath === target)
    throw new Error("Backup path is the Markdown target");
  const temporaryPath = stageFile(canonicalDirectory, bytes);
  try {
    try {
      // Publish without replacing an existing backup or exposing partial bytes.
      fs.linkSync(temporaryPath, backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readRegularFile(backupPath);
      if (!existing.bytes.equals(bytes)) {
        throw new Error(
          `Backup content does not match its hash: ${backupPath}`,
        );
      }
      const fd = fs.openSync(
        backupPath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  } finally {
    removeTemporary(temporaryPath);
  }
  syncDirectory(canonicalDirectory);
  return backupPath;
}

/**
 * Synchronously replace an existing regular Markdown file, following symlinks.
 * Backups contain the exact prior bytes at <sha256>.md and are never overwritten.
 * Changes observed during staging cause MarkdownConflictError, even without an
 * expectedContent. The final check/rename is not an OS compare-and-swap: callers
 * needing exclusion from other writers must coordinate outside this helper.
 * A directory fsync error after rename is reported even though content committed.
 * POSIX mode and ownership are retained; ACLs, xattrs and other hard links are not.
 */
export function writeMarkdownAtomically(
  filePath: string,
  content: string,
  options: { expectedContent?: string; backupDirectory?: string } = {},
): { previousContent: string; backupPath?: string } {
  const canonicalPath = fs.realpathSync(filePath);
  const previous = readRegularFile(canonicalPath);
  const previousContent = previous.bytes.toString("utf8");
  if (
    options.expectedContent !== undefined &&
    previousContent !== options.expectedContent
  ) {
    throw new MarkdownConflictError(filePath);
  }
  const directory = path.dirname(canonicalPath);
  const temporaryPath = stageFile(
    directory,
    Buffer.from(content, "utf8"),
    previous.stat,
  );
  let committed = false;
  try {
    const backupPath =
      options.backupDirectory === undefined
        ? undefined
        : preserveBackup(
            options.backupDirectory,
            previous.bytes,
            canonicalPath,
          );

    // Open the directory before the final read so no backup/staging work occurs
    // between checking the expected content and committing the replacement.
    const directoryFd = fs.openSync(
      directory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
    );
    try {
      let current: ReturnType<typeof readRegularFile>;
      try {
        if (fs.realpathSync(filePath) !== canonicalPath) {
          throw new MarkdownConflictError(filePath);
        }
        current = readRegularFile(canonicalPath);
      } catch (error) {
        if (error instanceof MarkdownConflictError) throw error;
        throw new MarkdownConflictError(filePath);
      }
      if (
        current.stat.dev !== previous.stat.dev ||
        current.stat.ino !== previous.stat.ino ||
        current.stat.mode !== previous.stat.mode ||
        current.stat.uid !== previous.stat.uid ||
        current.stat.gid !== previous.stat.gid ||
        !current.bytes.equals(previous.bytes) ||
        (options.expectedContent !== undefined &&
          current.bytes.toString("utf8") !== options.expectedContent)
      ) {
        throw new MarkdownConflictError(filePath);
      }
      fs.renameSync(temporaryPath, canonicalPath);
      committed = true;
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
    return backupPath === undefined
      ? { previousContent }
      : { previousContent, backupPath };
  } finally {
    if (!committed) removeTemporary(temporaryPath);
  }
}
