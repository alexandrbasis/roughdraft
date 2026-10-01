import { execFile } from "node:child_process";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createApp } from "./index";

const execute = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
let server: Server | undefined;
let directory: string | undefined;
let closeDatabase: (() => void) | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  if (server?.listening)
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  closeDatabase?.();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

// Four fresh CLI subprocesses share one real daemon; startup can exceed Vitest's
// 5-second default when the server and browser suites run in parallel.
it("reads saved feedback and ongoing editing through the actual CLI before Done", async () => {
  directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-cli-read-")),
  );
  const documentPath = path.join(directory, "review.md");
  fs.writeFileSync(documentPath, "# Review\n");
  const { app } = createApp({
    stateDirectory: directory,
    projectDir: directory,
    serverRoot: root,
    staticDirPath: directory,
  });
  closeDatabase = () => app.locals.reviewDatabase.close();
  server = createServer((request, response) => {
    const logFile = process.env.THOUGHTFUL_SLOG_FILE;
    if (logFile)
      response.once("finish", () =>
        fs.appendFileSync(
          logFile,
          `${JSON.stringify({
            ts: new Date().toISOString(),
            source: "cli-read.integration.test.ts",
            event: "http.completed",
            data: {
              method: request.method,
              path: request.url?.split("?")[0],
              status: response.statusCode,
            },
          })}\n`,
        ),
      );
    app(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test listener");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  fs.writeFileSync(
    path.join(directory, "server.json"),
    JSON.stringify({
      url: baseUrl,
      port: address.port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }),
  );
  const cliEnv = {
    ...process.env,
    ROUGHDRAFT_HOST: "",
    ROUGHDRAFT_STATE_DIR: directory,
    ROUGHDRAFT_STATE_FILE: path.join(directory, "server.json"),
    ROUGHDRAFT_PORT: String(address.port),
  };
  async function cli(...args: string[]) {
    const script = `import { runCli } from ${JSON.stringify(path.join(root, "packages/server/src/cli.ts"))}; process.exit(await runCli(process.argv.slice(1)));`;
    return execute(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script, "--", ...args],
      { cwd: root, env: cliEnv, timeout: 10_000 },
    );
  }

  const original = JSON.parse(
    (await cli("read", documentPath, "--json")).stdout,
  );
  expect(original.iterations).toMatchObject([
    { number: 1, actor: "unknown", completedAt: null },
  ]);
  const originalText = (await cli("read", documentPath)).stdout;
  expect(originalText).toContain("Completed versions: 0");
  expect(originalText).toMatch(
    /V1: Original, first seen \d{4}-\d{2}-\d{2}T[^\n]+; completion unknown/,
  );

  const opened = await fetch(new URL("/api/reviews", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentPath }),
  });
  expect(opened.status).toBe(201);
  const savedContent =
    "# Review\nThe {==claim==}{>>Please cite this.<<}{#c1} needs support.\n";
  const saved = await fetch(
    new URL(
      `/api/markdown-file?projectPath=${encodeURIComponent(directory)}&path=review.md`,
      baseUrl,
    ),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: savedContent }),
    },
  );
  expect(saved.status).toBe(200);

  const jsonResult = JSON.parse(
    (await cli("read", documentPath, "--json")).stdout,
  );
  expect(jsonResult).toMatchObject({
    documentPath,
    content: savedContent,
    editingState: "editing",
    reviewIndex: { summary: { comments: 1 } },
  });
  expect(jsonResult.iterations).toHaveLength(1);
  expect(jsonResult.iterations[0].number).toBe(1);
  expect(jsonResult.iterations[0].actor).toBe("agent");
  expect(jsonResult.iterations[0].completedAt).toEqual(expect.any(String));
  expect(jsonResult.currentIteration?.number).toBe(2);
  expect(jsonResult.drafts).toEqual([]);

  const humanResult = (await cli("read", documentPath)).stdout;
  expect(humanResult).toContain("Review state: editing");
  expect(humanResult).toContain("Completed versions: 1");
  expect(humanResult).toMatch(/V1: Agent, completed \d{4}-\d{2}-\d{2}T/);
  expect(humanResult).toContain(
    "Current iteration: V2 (user, in progress since ",
  );
  expect(humanResult).toContain("Saved feedback: 1 comment(s)");
  expect(humanResult).toContain(savedContent);
  const afterRead = await fetch(
    new URL(
      `/api/reviews/document?documentPath=${encodeURIComponent(documentPath)}`,
      baseUrl,
    ),
  );
  expect(afterRead.status).toBe(200);
  expect((await afterRead.json()).iterations).toHaveLength(1);
  expect(fs.readFileSync(documentPath, "utf8")).toBe(savedContent);
}, 20_000);
