#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releaseArchive } from "../packages/server/release-info.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const archive = releaseArchive(manifest);
if (!archive)
  throw new Error(
    "A scoped package, version, and GitHub repository are required.",
  );
if (
  process.env.GITHUB_REF_TYPE === "tag" &&
  process.env.GITHUB_REF_NAME !== archive.tag
) {
  throw new Error(
    `Tag ${process.env.GITHUB_REF_NAME} does not match package version ${archive.tag}.`,
  );
}
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain").length > 0;
if (process.env.GITHUB_ACTIONS === "true" && dirty)
  throw new Error("Release checkout must be clean.");
await mkdir(path.join(root, ".context", "release"), { recursive: true });
const directory = await mkdtemp(
  path.join(root, ".context", "release", `${archive.tag}-`),
);
const packed = JSON.parse(
  execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--json", "--pack-destination", directory, "--ignore-scripts"],
    { cwd: root, encoding: "utf8", timeout: 120_000 },
  ),
)[0];
if (packed.filename !== archive.name)
  throw new Error(`Unexpected archive name: ${packed.filename}`);
const tarball = path.join(directory, archive.name);
const sha256 = createHash("sha256")
  .update(await readFile(tarball))
  .digest("hex");
await writeFile(
  path.join(directory, "SHA256SUMS.txt"),
  `${sha256}  ${archive.name}\n`,
);
await writeFile(
  path.join(directory, "release-manifest.json"),
  `${JSON.stringify(
    {
      packageName: manifest.name,
      ...archive,
      commit,
      dirty,
      sha256,
    },
    null,
    2,
  )}\n`,
);
if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `directory=${directory}\ntarball=${tarball}\ntag=${archive.tag}\nprerelease=${archive.version.includes("-")}\n`,
  );
}
console.log(
  `Prepared ${archive.tag} at ${commit}${dirty ? " (uncommitted changes)" : ""}`,
);
console.log(`Archive: ${tarball}`);
console.log(`SHA256: ${sha256}`);
