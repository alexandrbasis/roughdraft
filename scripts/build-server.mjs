#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceDir = path.join(repoRoot, "packages/server/src");
const outdir = path.join(repoRoot, "packages/server/dist");
const files = await fs.readdir(sourceDir);
const entryPoints = files
  .filter(
    (file) =>
      file.endsWith(".ts") &&
      !file.endsWith(".test.ts") &&
      !file.endsWith(".d.ts"),
  )
  .map((file) => path.join(sourceDir, file));

// Bundle the private RFM workspace package so consumers never resolve a file:
// dependency. Registry dependencies stay external and are declared at the root.
// Keep shared chunks beside entrypoints: runtime asset/state paths use import.meta.url.
await fs.mkdir(outdir, { recursive: true });
for (const file of await fs.readdir(outdir)) {
  if (file.endsWith(".js") || file.endsWith(".js.map")) {
    await fs.unlink(path.join(outdir, file));
  }
}
await build({
  entryPoints,
  outdir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["express", "yaml"],
  chunkNames: "chunk-[hash]",
  logLevel: "warning",
});
