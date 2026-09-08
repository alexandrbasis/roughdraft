import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runCli } from "./cli";

let dir: string;
let documentPath: string;
let errors: string[];
let logs: string[];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-cli-atomic-"));
  documentPath = path.join(dir, "review.md");
  fs.writeFileSync(documentPath, "original\n", { mode: 0o640 });
  errors = [];
  logs = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function backup(content: string) {
  return path.join(
    dir,
    "state",
    "markdown-backups",
    `${createHash("sha256").update(content).digest("hex")}.md`,
  );
}

async function remoteSaves(contents: string[], beforeSaves?: () => void) {
  return runCli(["open", documentPath, "--no-open"], {
    env: {
      ROUGHDRAFT_HOST: "http://remote.invalid",
      ROUGHDRAFT_STATE_DIR: path.join(dir, "state"),
    },
    cwd: dir,
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
    fetchImpl: async (_input, init) => {
      if (init?.method === "POST")
        return new Response(
          JSON.stringify({
            viewerUrl: "http://remote.invalid/?session=test",
            version: "original-version",
          }),
        );
      beforeSaves?.();
      return new Response(
        contents
          .map(
            (content) =>
              `event: save\ndata: ${JSON.stringify({ content })}\n\n`,
          )
          .join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
    resolveUpdateStatus: async () => ({
      packageName: "roughdraft",
      currentVersion: "1",
      latestVersion: "1",
      updateAvailable: false,
      updateCommand: "",
    }),
  });
}

it("remote saves retain each prior version and use the last successful content for the next comparison", async () => {
  expect(await remoteSaves(["first save\n", "second save\n"])).toBe(0);
  expect(fs.readFileSync(documentPath, "utf8")).toBe("second save\n");
  expect(fs.readFileSync(backup("original\n"), "utf8")).toBe("original\n");
  expect(fs.readFileSync(backup("first save\n"), "utf8")).toBe("first save\n");
  expect(fs.statSync(documentPath).mode & 0o777).toBe(0o640);
  expect(errors).toEqual([]);
});

it("a local edit after registration is preserved and stops all queued remote saves", async () => {
  expect(
    await remoteSaves(["remote save\n", "another save\n"], () =>
      fs.writeFileSync(documentPath, "local edit\n"),
    ),
  ).toBe(1);
  expect(fs.readFileSync(documentPath, "utf8")).toBe("local edit\n");
  expect(errors.join("\n")).toContain("Markdown changed");
  expect(logs.some((message) => message.startsWith("Saved "))).toBe(false);
});

it("a removed local file is not recreated by a remote save", async () => {
  expect(
    await remoteSaves(["remote save\n"], () => fs.unlinkSync(documentPath)),
  ).toBe(1);
  expect(fs.existsSync(documentPath)).toBe(false);
});

it("remote saves follow a Markdown symlink without replacing the link", async () => {
  const target = documentPath;
  documentPath = path.join(dir, "linked.md");
  fs.symlinkSync(target, documentPath);
  expect(await remoteSaves(["remote save\n"])).toBe(0);
  expect(fs.lstatSync(documentPath).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(target, "utf8")).toBe("remote save\n");
  expect(fs.readFileSync(backup("original\n"), "utf8")).toBe("original\n");
});

it("a backup failure prevents the remote replacement and returns an error", async () => {
  fs.mkdirSync(path.join(dir, "state"));
  fs.writeFileSync(path.join(dir, "state", "markdown-backups"), "occupied");
  expect(await remoteSaves(["remote save\n"])).toBe(1);
  expect(fs.readFileSync(documentPath, "utf8")).toBe("original\n");
  expect(errors.join("\n")).toContain("Failed to write");
});
