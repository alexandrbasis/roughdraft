import { createServer, type Server } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { waitForReviewEvents } from "./review-events-watch.js";

const LOOPBACK_PORTS = [4607, 4608, 4609] as const;
const repoRoot = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const childEntry = path.join(repoRoot, "packages/server/src/child.ts");
const cliEntry = path.join(repoRoot, "packages/server/src/cli.ts");
const mcpEntry = path.join(repoRoot, "packages/server/src/mcp.ts");

interface JsonRpcMessage {
  id?: string | number | null;
  result?: unknown;
  error?: { message?: string };
  [key: string]: unknown;
}

interface SpawnedProcess {
  child: ChildProcessWithoutNullStreams;
  stderr: () => string;
}

async function findLoopbackPort(): Promise<number> {
  for (const port of LOOPBACK_PORTS) {
    const probe = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(port, "127.0.0.1", () => resolve());
      });
      await closeServer(probe);
      return port;
    } catch (error) {
      await closeServer(probe).catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") continue;
      throw error;
    }
  }

  throw new Error(
    `No loopback test port is available in ${LOOPBACK_PORTS.join(", ")}.`,
  );
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function spawnTypeScript(
  entry: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): SpawnedProcess {
  const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return { child, stderr: () => stderr };
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 8_000,
): Promise<{ code: number | null }> {
  if (child.exitCode !== null) return { code: child.exitCode };

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Subprocess did not exit within the test deadline."));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve({ code });
    });
  });
}

async function terminateProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForExit(child, 2_000);
  } catch {
    child.kill("SIGKILL");
  }
}

async function waitForServer(
  baseUrl: string,
  processHandle: SpawnedProcess,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const { child } = processHandle;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Server exited (${child.signalCode ?? child.exitCode}) before becoming ready.\n${processHandle.stderr()}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/status`, {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for ${baseUrl}/api/status.\n${processHandle.stderr()}`,
  );
}

async function waitForWatcher(
  baseUrl: string,
  projectDir: string,
): Promise<void> {
  const url = new URL(`${baseUrl}/api/review-events/status`);
  url.searchParams.set("projectPath", projectDir);
  url.searchParams.set("path", "draft.md");
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const response = await fetch(url);
    const payload = (await response.json()) as { watcherCount?: number };
    if ((payload.watcherCount ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for a review watcher.");
}

async function emitReviewCompleted(
  baseUrl: string,
  projectDir: string,
): Promise<{ event: { sequence: number; type: string } }> {
  const response = await fetch(`${baseUrl}/api/review-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectPath: projectDir, path: "draft.md" }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    event: { sequence: number; type: string };
  };
}

class StdioMcpClient {
  private readonly processHandle: SpawnedProcess;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<
    string,
    {
      resolve: (message: JsonRpcMessage) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly notifications: JsonRpcMessage[] = [];
  private frameCount = 0;

  constructor(env: NodeJS.ProcessEnv = {}) {
    const mcpCode = `
      import { startMcpServer } from ${JSON.stringify(mcpEntry)};
      startMcpServer();
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", mcpCode],
      {
        cwd: repoRoot,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    this.processHandle = { child, stderr: () => stderr };
    this.processHandle.child.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
      this.readFrames();
    });
    this.processHandle.child.on("exit", () => {
      for (const waiter of this.pending.values()) {
        waiter.reject(
          new Error(this.processHandle.stderr() || "MCP process exited."),
        );
      }
      this.pending.clear();
    });
  }

  get stderr(): string {
    return this.processHandle.stderr();
  }

  get frames(): number {
    return this.frameCount;
  }

  get receivedNotifications(): JsonRpcMessage[] {
    return this.notifications;
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  request(
    id: number,
    method: string,
    params?: unknown,
  ): Promise<JsonRpcMessage> {
    const key = String(id);
    const response = new Promise<JsonRpcMessage>((resolve, reject) => {
      this.pending.set(key, { resolve, reject });
    });
    this.write({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    return response;
  }

  async close(): Promise<void> {
    this.processHandle.child.stdin.end();
    await waitForExit(this.processHandle.child).catch(() => undefined);
    await terminateProcess(this.processHandle.child);
  }

  private write(message: Record<string, unknown>): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.processHandle.child.stdin.write(
      Buffer.concat([
        Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii"),
        body,
      ]),
    );
  }

  private readFrames(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = header.match(/content-length:\s*(\d+)/i);
      if (!match) throw new Error(`Invalid MCP frame header: ${header}`);
      const bodyStart = headerEnd + 4;
      const bodyLength = Number.parseInt(match[1] ?? "0", 10);
      if (this.buffer.length < bodyStart + bodyLength) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + bodyLength);
      this.buffer = this.buffer.subarray(bodyStart + bodyLength);
      this.frameCount += 1;
      const message = JSON.parse(body.toString("utf8")) as JsonRpcMessage;
      if (message.id === undefined || message.id === null) {
        this.notifications.push(message);
        continue;
      }
      const waiter = this.pending.get(String(message.id));
      if (waiter) {
        this.pending.delete(String(message.id));
        waiter.resolve(message);
      }
    }
  }
}

function toolResult<T>(message: JsonRpcMessage): T {
  if (message.error)
    throw new Error(message.error.message ?? "MCP request failed.");
  const result = message.result as { content?: Array<{ text?: string }> };
  return JSON.parse(result.content?.[0]?.text ?? "null") as T;
}

describe("real CLI and stdio MCP review workflow", () => {
  const children: ChildProcessWithoutNullStreams[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      children.splice(0).map((child) => terminateProcess(child)),
    );
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("recovers from a real dropped loopback socket without moving the cursor", async () => {
    const port = await findLoopbackPort();
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {
        // Drain the body before choosing the response boundary.
      }
      serverAttempt += 1;
      const attempt = serverAttempt;
      if (attempt === 1) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ events: [], timedOut: true, nextSequence: 8 }),
        );
        return;
      }
      if (attempt === 2) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          events: [{ type: "review.completed", sequence: 8 }],
          timedOut: false,
          nextSequence: 9,
        }),
      );
    });
    let serverAttempt = 0;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
      });
      const result = await waitForReviewEvents({
        fetchImpl: fetch,
        request: {
          projectPath: "/fixture",
          path: "draft.md",
          batchWindowSeconds: 0,
        },
        timeoutSeconds: 2,
        url: new URL(`http://127.0.0.1:${port}/api/review-events/watch`),
      });

      expect(result).toMatchObject({ timedOut: false });
      expect(result.events).toEqual([
        expect.objectContaining({ sequence: 8, type: "review.completed" }),
      ]);
      expect(serverAttempt).toBe(3);
    } finally {
      await closeServer(server);
    }
  });

  it("completes two review rounds through CLI and stdio MCP subprocesses", async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "roughdraft-review-workflow-"),
    );
    tempDirs.push(tempDir);
    const projectDir = path.join(tempDir, "project");
    const stateFile = path.join(tempDir, "state", "server.json");
    const documentPath = path.join(projectDir, "draft.md");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      documentPath,
      '# Draft\n\nKeep {==this claim==}{>>Needs proof<<}{id="c1" by="user" at="2026-09-08T00:00:00.000Z"}.\n',
    );

    const port = await findLoopbackPort();
    const serverProcess = spawnTypeScript(
      childEntry,
      ["--port", String(port), "--project-dir", projectDir],
      {
        ROUGHDRAFT_BIND_HOST: "127.0.0.1",
        ROUGHDRAFT_STATE_FILE: stateFile,
      },
    );
    children.push(serverProcess.child);
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServer(baseUrl, serverProcess);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        port,
        pid: serverProcess.child.pid,
        startedAt: new Date().toISOString(),
        url: baseUrl,
      }),
    );

    const cliCode = `
      import { runCli } from ${JSON.stringify(cliEntry)};
      const exitCode = await runCli(JSON.parse(process.env.ROUGHDRAFT_TEST_ARGS ?? "[]"));
      process.exitCode = exitCode;
    `;
    const cliProcess = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", cliCode],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          ROUGHDRAFT_TEST_ARGS: JSON.stringify([
            "watch",
            documentPath,
            "--json",
            "--timeout",
            "5",
            "--batch-window",
            "0",
          ]),
          ROUGHDRAFT_STATE_FILE: stateFile,
          ROUGHDRAFT_NO_OPEN: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(cliProcess as unknown as ChildProcessWithoutNullStreams);
    let cliStdout = "";
    let cliStderr = "";
    cliProcess.stdout.on("data", (chunk) => {
      cliStdout += String(chunk);
    });
    cliProcess.stderr.on("data", (chunk) => {
      cliStderr += String(chunk);
    });
    await waitForWatcher(baseUrl, projectDir);
    const firstEvent = await emitReviewCompleted(baseUrl, projectDir);
    const firstExit = await waitForExit(
      cliProcess as unknown as ChildProcessWithoutNullStreams,
    );

    expect(firstExit.code).toBe(0);
    expect(cliStderr).toBe("");
    const firstPayload = JSON.parse(cliStdout.trim()) as {
      events: Array<{ sequence: number; type: string }>;
      timedOut: boolean;
    };
    expect(firstPayload).toMatchObject({ timedOut: false });
    expect(firstPayload.events).toEqual([
      expect.objectContaining({
        sequence: firstEvent.event.sequence,
        type: "review.completed",
      }),
    ]);

    const mcp = new StdioMcpClient({ ROUGHDRAFT_STATE_FILE: stateFile });
    try {
      const initialized = await mcp.request(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "integration-test", version: "1" },
      });
      expect(initialized.result).toMatchObject({
        capabilities: { tools: {} },
        serverInfo: { name: "roughdraft" },
      });
      const listed = await mcp.request(2, "tools/list");
      const listedTools = (listed.result as { tools: Array<{ name: string }> })
        .tools;
      expect(listedTools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "roughdraft_get_pending_feedback",
          "roughdraft_reply_to_comment",
          "roughdraft_mark_resolved",
          "roughdraft_watch_review_events",
        ]),
      );
      mcp.notify("notifications/initialized");

      const pending = toolResult<{
        items: Array<{ id: string; status: string | null }>;
      }>(
        await mcp.request(3, "tools/call", {
          name: "roughdraft_get_pending_feedback",
          arguments: { documentPath },
        }),
      );
      expect(pending.items).toEqual([
        expect.objectContaining({ id: "c1", status: null }),
      ]);

      expect(
        toolResult<{ ok: boolean }>(
          await mcp.request(4, "tools/call", {
            name: "roughdraft_reply_to_comment",
            arguments: {
              documentPath,
              parentId: "c1",
              message: "I added the missing source.",
              author: "AI",
            },
          }),
        ),
      ).toMatchObject({ ok: true });
      expect(
        toolResult<{ ok: boolean }>(
          await mcp.request(5, "tools/call", {
            name: "roughdraft_mark_resolved",
            arguments: {
              documentPath,
              targetId: "c1",
              summary: "Addressed in the reply.",
            },
          }),
        ),
      ).toMatchObject({ ok: true });

      const secondWatch = mcp.request(6, "tools/call", {
        name: "roughdraft_watch_review_events",
        arguments: {
          documentPath,
          projectPath: projectDir,
          timeoutSeconds: 5,
          batchWindowSeconds: 0,
        },
      });
      await waitForWatcher(baseUrl, projectDir);
      await emitReviewCompleted(baseUrl, projectDir);
      const secondPayload = toolResult<{
        events: Array<{ sequence: number; type: string }>;
        timedOut: boolean;
      }>(await secondWatch);

      expect(secondPayload).toMatchObject({ timedOut: false });
      expect(secondPayload.events).toEqual([
        expect.objectContaining({ sequence: 2, type: "review.completed" }),
      ]);
      const finalMarkdown = fs.readFileSync(documentPath, "utf8");
      expect(finalMarkdown).toContain("I added the missing source.");
      expect(finalMarkdown).toContain('status="resolved"');
      expect(mcp.frames).toBeGreaterThanOrEqual(6);
      expect(mcp.receivedNotifications).toEqual([]);
      expect(mcp.stderr).toBe("");
    } finally {
      await mcp.close();
    }
  }, 15_000);
});
