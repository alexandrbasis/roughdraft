import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MarkdownConflictError,
  writeMarkdownAtomically,
} from "./atomic-markdown";

it("preserves Markdown contents and its symlink when expectedContent mismatches", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "roughdraft-atomic-"),
  );
  try {
    const filePath = path.join(directory, "document.md");
    const symlinkPath = path.join(directory, "review.md");
    const currentContent = "# A newer edit\n";
    fs.writeFileSync(filePath, currentContent);
    fs.symlinkSync("document.md", symlinkPath);

    let writeError: unknown;
    try {
      writeMarkdownAtomically(symlinkPath, "# Stale replacement\n", {
        expectedContent: "# Earlier version\n",
      });
    } catch (error) {
      writeError = error;
    }

    expect({
      contents: fs.readFileSync(filePath, "utf8"),
      isSymlink: fs.lstatSync(symlinkPath).isSymbolicLink(),
      symlinkTarget: fs.readlinkSync(symlinkPath),
    }).toEqual({
      contents: currentContent,
      isSymlink: true,
      symlinkTarget: "document.md",
    });
    expect(writeError).toBeInstanceOf(MarkdownConflictError);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// Real filesystem fixtures protect the save contract; spies only inject failures
// or interleave an external edit at an otherwise nondeterministic I/O boundary.
describe("atomic Markdown saves", () => {
  let directory: string;
  let filePath: string;
  const original = "---\ntitle: Draft\n---\n\n{>>review<<}\nשלום\n";

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-atomic-"));
    filePath = path.join(directory, "document.md");
    fs.writeFileSync(filePath, original);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function backupPathOf(result: { backupPath?: string }): string {
    if (!result.backupPath) throw new Error("Expected a backup path");
    return result.backupPath;
  }

  function assertNoTemporaryFiles(dir = directory): void {
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  }

  it("replaces a symlink target, preserves mode/owner, and leaves existing readers on the old version", () => {
    const link = path.join(directory, "review.md");
    fs.symlinkSync("document.md", link);
    fs.chmodSync(filePath, 0o640);
    const before = fs.statSync(filePath);
    const reader = fs.openSync(filePath, "r");
    try {
      expect(
        writeMarkdownAtomically(link, "# Updated\n", {
          expectedContent: original,
        }),
      ).toEqual({ previousContent: original });
      expect(fs.readFileSync(filePath, "utf8")).toBe("# Updated\n");
      expect(fs.readFileSync(reader, "utf8")).toBe(original);
      expect(fs.readlinkSync(link)).toBe("document.md");
      const after = fs.statSync(filePath);
      expect(after.mode & 0o7777).toBe(0o640);
      expect([after.uid, after.gid]).toEqual([before.uid, before.gid]);
      expect(after.ino).not.toBe(before.ino);
      assertNoTemporaryFiles();
    } finally {
      fs.closeSync(reader);
    }
  });

  it("handles an empty expected version and empty replacement", () => {
    fs.writeFileSync(filePath, "");
    expect(
      writeMarkdownAtomically(filePath, "new", { expectedContent: "" }),
    ).toEqual({ previousContent: "" });
    expect(() =>
      writeMarkdownAtomically(filePath, "stale", { expectedContent: "" }),
    ).toThrow(MarkdownConflictError);
    expect(writeMarkdownAtomically(filePath, "")).toEqual({
      previousContent: "new",
    });
    expect(fs.readFileSync(filePath, "utf8")).toBe("");
  });

  it("stores exact prior bytes at a stable SHA-256 address and reuses that backup", () => {
    const backupDirectory = path.join(directory, "backups", "nested");
    // Known SHA-256 vector for 'abc', independent of the implementation.
    fs.writeFileSync(filePath, "abc");
    const first = writeMarkdownAtomically(filePath, "changed", {
      backupDirectory,
    });
    expect(path.basename(backupPathOf(first))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.md",
    );
    expect(fs.readFileSync(backupPathOf(first), "utf8")).toBe("abc");
    expect(fs.statSync(backupPathOf(first)).mode & 0o777).toBe(0o600);
    const inode = fs.statSync(backupPathOf(first)).ino;
    fs.writeFileSync(filePath, "abc");
    const second = writeMarkdownAtomically(filePath, "changed again", {
      backupDirectory,
    });
    expect(second.backupPath).toBe(first.backupPath);
    expect(fs.statSync(backupPathOf(second)).ino).toBe(inode);
    expect(fs.readdirSync(backupDirectory)).toEqual([
      path.basename(backupPathOf(first)),
    ]);
    assertNoTemporaryFiles();
  });

  it("backs up original bytes without a UTF-8 round trip", () => {
    const bytes = Buffer.from([0xff, 0x0d, 0x0a, 0x00]);
    fs.writeFileSync(filePath, bytes);
    const result = writeMarkdownAtomically(filePath, "new", {
      backupDirectory: path.join(directory, "backups"),
    });
    expect(fs.readFileSync(backupPathOf(result))).toEqual(bytes);
  });

  it.each([
    "directory",
    "fifo",
  ])("rejects a %s without replacing it or hanging", (kind) => {
    fs.unlinkSync(filePath);
    if (kind === "directory") fs.mkdirSync(filePath);
    else execFileSync("mkfifo", [filePath]);
    const before = fs.lstatSync(filePath);
    expect(() => writeMarkdownAtomically(filePath, "new")).toThrow(
      "Not a regular file",
    );
    expect(fs.lstatSync(filePath).ino).toBe(before.ino);
    assertNoTemporaryFiles();
  });

  it("does not create a missing target or replace a dangling link", () => {
    fs.unlinkSync(filePath);
    expect(() => writeMarkdownAtomically(filePath, "new")).toThrow();
    expect(fs.existsSync(filePath)).toBe(false);
    fs.symlinkSync("missing.md", filePath);
    expect(() => writeMarkdownAtomically(filePath, "new")).toThrow();
    expect(fs.readlinkSync(filePath)).toBe("missing.md");
    assertNoTemporaryFiles();
  });

  it.each([
    true,
    false,
  ])("rejects an edit during staging with expectedContent=%s", (useExpected) => {
    const sync = fs.fsyncSync.bind(fs);
    let edited = false;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      sync(fd);
      if (!edited && fs.fstatSync(fd).isFile()) {
        edited = true;
        fs.writeFileSync(filePath, "external edit");
      }
    });
    expect(() =>
      writeMarkdownAtomically(
        filePath,
        "new",
        useExpected ? { expectedContent: original } : {},
      ),
    ).toThrow(MarkdownConflictError);
    expect(edited).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toBe("external edit");
    assertNoTemporaryFiles();
  });

  it("rechecks expected content after backup publication", () => {
    const link = fs.linkSync.bind(fs);
    vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      link(source, destination);
      fs.writeFileSync(filePath, "external edit during backup");
    });
    const backupDirectory = path.join(directory, "backups");
    expect(() =>
      writeMarkdownAtomically(filePath, "new", {
        expectedContent: original,
        backupDirectory,
      }),
    ).toThrow(MarkdownConflictError);
    expect(fs.readFileSync(filePath, "utf8")).toBe(
      "external edit during backup",
    );
    expect(
      fs.readFileSync(
        path.join(backupDirectory, fs.readdirSync(backupDirectory)[0]),
        "utf8",
      ),
    ).toBe(original);
    assertNoTemporaryFiles();
    assertNoTemporaryFiles(backupDirectory);
  });

  it("rejects a symlink retargeted while staging", () => {
    const link = path.join(directory, "review.md");
    const other = path.join(directory, "other.md");
    fs.symlinkSync("document.md", link);
    fs.writeFileSync(other, "other");
    const sync = fs.fsyncSync.bind(fs);
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce((fd) => {
      sync(fd);
      fs.unlinkSync(link);
      fs.symlinkSync("other.md", link);
    });
    expect(() => writeMarkdownAtomically(link, "new")).toThrow(
      MarkdownConflictError,
    );
    expect(fs.readFileSync(filePath, "utf8")).toBe(original);
    expect(fs.readFileSync(other, "utf8")).toBe("other");
    expect(fs.readlinkSync(link)).toBe("other.md");
    assertNoTemporaryFiles();
  });

  it.each([
    "write",
    "file sync",
    "rename",
    "ownership",
  ])("leaves the original intact and cleans staging after %s failure", (operation) => {
    const failure = new Error(`injected ${operation} failure`);
    if (operation === "write") {
      const write = fs.writeFileSync.bind(fs);
      vi.spyOn(fs, "writeFileSync").mockImplementationOnce((fd) => {
        write(fd, "partial");
        throw failure;
      });
    } else if (operation === "file sync") {
      vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
        throw failure;
      });
    } else if (operation === "rename") {
      vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
        throw failure;
      });
    } else {
      const stat = fs.fstatSync.bind(fs);
      vi.spyOn(fs, "fstatSync").mockImplementation((...args) => {
        const result = stat(...args);
        if (result.size === 3) result.uid = Number(result.uid) + 1;
        return result;
      });
      vi.spyOn(fs, "fchownSync").mockImplementationOnce(() => {
        throw failure;
      });
    }
    expect(() => writeMarkdownAtomically(filePath, "new")).toThrow(failure);
    expect(fs.readFileSync(filePath, "utf8")).toBe(original);
    assertNoTemporaryFiles();
  });

  it("aborts without changing Markdown if backup publication fails", () => {
    const backupDirectory = path.join(directory, "backups");
    vi.spyOn(fs, "linkSync").mockImplementationOnce(() => {
      throw new Error("backup unavailable");
    });
    expect(() =>
      writeMarkdownAtomically(filePath, "new", { backupDirectory }),
    ).toThrow("backup unavailable");
    expect(fs.readFileSync(filePath, "utf8")).toBe(original);
    expect(fs.readdirSync(backupDirectory)).toEqual([]);
    assertNoTemporaryFiles();
  });

  it.each([
    "corrupt",
    "symlink",
  ])("refuses a %s backup at the content address", (kind) => {
    const backupDirectory = path.join(directory, "backups");
    const result = writeMarkdownAtomically(filePath, "new", {
      backupDirectory,
    });
    if (kind === "corrupt")
      fs.writeFileSync(backupPathOf(result), "corrupt backup");
    else {
      fs.unlinkSync(backupPathOf(result));
      fs.symlinkSync(filePath, backupPathOf(result));
    }
    fs.writeFileSync(filePath, original);
    expect(() =>
      writeMarkdownAtomically(filePath, "newer", { backupDirectory }),
    ).toThrow();
    expect(fs.readFileSync(filePath, "utf8")).toBe(original);
    if (kind === "corrupt")
      expect(fs.readFileSync(backupPathOf(result), "utf8")).toBe(
        "corrupt backup",
      );
    else expect(fs.lstatSync(backupPathOf(result)).isSymbolicLink()).toBe(true);
    assertNoTemporaryFiles();
    assertNoTemporaryFiles(backupDirectory);
  });

  it("reports directory durability failure after commit without pretending the original survived", () => {
    const sync = fs.fsyncSync.bind(fs);
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory())
        throw new Error("directory sync failed");
      sync(fd);
    });
    expect(() => writeMarkdownAtomically(filePath, "new")).toThrow(
      "directory sync failed",
    );
    expect(fs.readFileSync(filePath, "utf8")).toBe("new");
    assertNoTemporaryFiles();
  });

  it("syncs the replacement and completed backup before rename, then syncs the Markdown directory", () => {
    const backupDirectory = path.join(directory, "backups");
    fs.mkdirSync(backupDirectory);
    const events: string[] = [];
    const sync = fs.fsyncSync.bind(fs);
    const rename = fs.renameSync.bind(fs);
    const dirInode = fs.statSync(directory).ino;
    const backupInode = fs.statSync(backupDirectory).ino;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      const stat = fs.fstatSync(fd);
      events.push(
        stat.isFile()
          ? "file-sync"
          : stat.ino === backupInode
            ? "backup-dir-sync"
            : stat.ino === dirInode
              ? "markdown-dir-sync"
              : "other-dir-sync",
      );
      sync(fd);
    });
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      expect(path.dirname(String(source))).toBe(fs.realpathSync(directory));
      expect(fs.readFileSync(destination, "utf8")).toBe(original);
      expect(fs.readFileSync(source, "utf8")).toBe("new");
      events.push("rename");
      rename(source, destination);
    });
    writeMarkdownAtomically(filePath, "new", { backupDirectory });
    expect(events).toEqual([
      "file-sync",
      "file-sync",
      "backup-dir-sync",
      "rename",
      "markdown-dir-sync",
    ]);
  });
  it("never truncates or removes an existing file when an exclusive temp name collides", () => {
    const open = fs.openSync.bind(fs);
    let collision: string | undefined;
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      if (flags === "wx" && collision === undefined) {
        collision = String(target);
        fs.writeFileSync(target, "another writer owns this file");
      }
      return open(target, flags, mode);
    });
    expect(() => writeMarkdownAtomically(filePath, "new")).toThrow();
    if (!collision) throw new Error("Expected exclusive staging file creation");
    expect(fs.readFileSync(collision, "utf8")).toBe(
      "another writer owns this file",
    );
    expect(fs.readFileSync(filePath, "utf8")).toBe(original);
  });

  it("keeps Markdown unchanged when the backup directory cannot be synced", () => {
    const backupDirectory = path.join(directory, "backups");
    fs.mkdirSync(backupDirectory);
    const sync = fs.fsyncSync.bind(fs);
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory())
        throw new Error("backup durability failed");
      sync(fd);
    });
    expect(() =>
      writeMarkdownAtomically(filePath, "new", { backupDirectory }),
    ).toThrow("backup durability failed");
    expect(fs.readFileSync(filePath, "utf8")).toBe(original);
    assertNoTemporaryFiles();
    assertNoTemporaryFiles(backupDirectory);
  });

  it("refuses to overwrite a Markdown target that is itself the backup address", () => {
    const addressedTarget = path.join(
      directory,
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.md",
    );
    fs.writeFileSync(addressedTarget, "abc");
    expect(() =>
      writeMarkdownAtomically(addressedTarget, "new", {
        backupDirectory: directory,
      }),
    ).toThrow("Backup path is the Markdown target");
    expect(fs.readFileSync(addressedTarget, "utf8")).toBe("abc");
    assertNoTemporaryFiles();
  });
});
