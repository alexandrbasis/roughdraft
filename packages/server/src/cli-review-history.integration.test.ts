import { execFile } from "node:child_process";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createApp } from "./index";
import { callTool } from "./mcp";

const execute = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
let server: Server | undefined;
let dir: string | undefined;
let closeDatabase: (() => void) | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  if (server?.listening)
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  closeDatabase?.();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

it("delivers through the worktree CLI, persists explicit processing, and reads SQLite offline through MCP", async () => {
  dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-cli-sqlite-")),
  );
  const documentPath = path.join(dir, "review.md");
  fs.writeFileSync(documentPath, "# Review\n");
  const { app } = createApp({
    stateDirectory: dir,
    projectDir: dir,
    serverRoot: root,
    staticDirPath: dir,
  });
  closeDatabase = () => app.locals.reviewDatabase.close();
  server = createServer((req, res) => {
    const logFile = process.env.THOUGHTFUL_SLOG_FILE;
    if (logFile)
      res.once("finish", () =>
        fs.appendFileSync(
          logFile,
          `${JSON.stringify({
            ts: new Date().toISOString(),
            runId: process.env.THOUGHTFUL_SLOG_RUN_ID,
            source: "cli-review-history.integration.test.ts",
            event: "http.completed",
            data: {
              method: req.method,
              path: req.url?.split("?")[0],
              status: res.statusCode,
            },
          })}\n`,
        ),
      );
    app(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test listener");
  const url = `http://127.0.0.1:${address.port}`;
  fs.writeFileSync(
    path.join(dir, "server.json"),
    JSON.stringify({
      url,
      port: address.port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }),
  );
  const env = {
    ...process.env,
    ROUGHDRAFT_STATE_DIR: dir,
    ROUGHDRAFT_STATE_FILE: path.join(dir, "server.json"),
    ROUGHDRAFT_PORT: String(address.port),
  };
  async function cli(...args: string[]) {
    const script = `import { runCli } from ${JSON.stringify(path.join(root, "packages/server/src/cli.ts"))}; process.exit(await runCli(process.argv.slice(1)));`;
    const result = await execute(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script, "--", ...args],
      { cwd: root, env, timeout: 10_000 },
    );
    return JSON.parse(result.stdout);
  }
  async function post(route: string, body: unknown) {
    const response = await fetch(new URL(route, url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
    return response.json();
  }
  await post("/api/reviews", { documentPath });
  const completion = await post("/api/review-events", {
    projectPath: dir,
    path: "review.md",
    overallComment: "Check the delivery contract.",
  });
  const sequence = completion.event.sequence;
  const received = await cli(
    "watch",
    documentPath,
    "--replay",
    "--consumer-id",
    "integration-agent",
    "--json",
  );
  expect(received).toMatchObject({
    consumerId: "integration-agent",
    events: [{ sequence, roundId: expect.any(String) }],
    acknowledgements: [{ sequence, status: "received" }],
  });
  const beforeProcessing = await cli("history", documentPath, "--json");
  expect(beforeProcessing.rounds).toHaveLength(1);
  expect(beforeProcessing.snapshots.length).toBeGreaterThan(0);
  expect(beforeProcessing.acknowledgements).toMatchObject([
    { sequence, consumerId: "integration-agent", status: "received" },
  ]);
  const processed = await cli(
    "ack",
    String(sequence),
    "--consumer-id",
    "integration-agent",
    "--json",
  );
  expect(processed.status).toBe("processed");
  expect(
    await cli(
      "ack",
      String(sequence),
      "--consumer-id",
      "integration-agent",
      "--received",
      "--json",
    ),
  ).toEqual(processed);
  expect(
    await callTool(
      "roughdraft_get_review_history",
      { documentPath },
      env,
      fetch,
    ),
  ).toMatchObject({ acknowledgements: [{ status: "processed" }] });
  expect(
    await callTool("roughdraft_get_open_documents", {}, env, fetch),
  ).toMatchObject({ documents: [{ documentPath, status: "completed" }] });
  const beforeOfflineRead = fs.readFileSync(
    path.join(dir, "roughdraft.sqlite"),
  );
  fs.unlinkSync(path.join(dir, "server.json"));
  expect(
    await callTool("roughdraft_get_open_documents", {}, env, async () => {
      throw new Error("Offline listing must not fetch");
    }),
  ).toMatchObject({ documents: [{ documentPath, status: "completed" }] });
  expect(fs.readFileSync(path.join(dir, "roughdraft.sqlite"))).toEqual(
    beforeOfflineRead,
  );
}, 20_000);
