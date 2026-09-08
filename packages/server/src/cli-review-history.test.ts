import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCliDependencies, runCli } from "./cli";
import { callTool, startMcpServer } from "./mcp";
import { ReviewRegistry } from "./review-registry";

describe("review history and delivery acknowledgements", () => {
  let dir: string;
  let documentPath: string;
  let env: NodeJS.ProcessEnv;
  let requests: Array<{ pathname: string; body: Record<string, unknown> }>;
  let capable: boolean;
  let ackFails: boolean;
  let logs: string[];
  let errors: string[];
  const history = {
    rounds: [{ id: "round-1", status: "completed", eventSequence: 7 }],
    snapshots: [{ id: "snapshot-1", version: "v1", reason: "completed" }],
    acknowledgements: [],
  };
  const root = path.resolve(
    fileURLToPath(new URL("../../..", import.meta.url)),
  );

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-delivery-"));
    documentPath = path.join(dir, "draft with spaces.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    env = { ROUGHDRAFT_STATE_DIR: dir, ROUGHDRAFT_PORT: "7373" };
    fs.writeFileSync(
      path.join(dir, "server.json"),
      JSON.stringify({
        url: "http://localhost:7373",
        port: 7373,
        pid: 1234,
        startedAt: "2026-09-08T00:00:00Z",
      }),
    );
    requests = [];
    capable = true;
    ackFails = false;
    logs = [];
    errors = [];
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push({ pathname: url.pathname, body });
    if (url.pathname === "/api/status")
      return json({
        serverRoot: root,
        backend: "local-files",
        stateDirectory: dir,
        port: 7373,
        capabilities: {
          reviewHistory: capable,
          reviewAcknowledgements: capable,
        },
      });
    if (url.pathname === "/api/reviews/history") {
      expect(url.searchParams.get("documentPath")).toBe(documentPath);
      return json(history);
    }
    if (url.pathname === "/api/reviews") return json([{ documentPath }]);
    if (url.pathname === "/api/review-events/ack") {
      expect(init?.method).toBe("POST");
      if (ackFails) throw new Error("ack connection lost");
      return json({ ...body, updatedAt: "2026-09-08T00:00:00Z" });
    }
    if (url.pathname === "/api/review-events/watch") {
      if (body.timeoutSeconds === 0)
        return json({ events: [], timedOut: true, nextSequence: 7 });
      return json({
        events: [
          {
            sequence: 7,
            roundId: "round-1",
            documentPath,
            type: "review.completed",
          },
        ],
        timedOut: false,
        nextSequence: 8,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  function deps() {
    return createCliDependencies({
      env,
      cwd: dir,
      fetchImpl,
      log: (s) => logs.push(s),
      error: (s) => errors.push(s),
      isProcessRunning: () => true,
      spawnServerProcess: () => {
        throw new Error("Must not start a server");
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
  const acknowledgements = () =>
    requests
      .filter((r) => r.pathname === "/api/review-events/ack")
      .map((r) => r.body);

  it("CLI history returns the stored rounds and snapshots for a deleted file", async () => {
    fs.unlinkSync(documentPath);
    expect(await runCli(["history", documentPath, "--json"], deps())).toBe(0);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toEqual(history);
  });

  it.each([
    false,
    true,
  ])("CLI explicitly acknowledges processed or received (received=%s)", async (received) => {
    expect(
      await runCli(
        [
          "ack",
          "7",
          "--consumer-id",
          "agent-a",
          "--json",
          ...(received ? ["--received"] : []),
        ],
        deps(),
      ),
    ).toBe(0);
    expect(acknowledgements()).toEqual([
      {
        sequence: 7,
        consumerId: "agent-a",
        status: received ? "received" : "processed",
      },
    ]);
    expect(JSON.parse(logs[0])).toMatchObject(acknowledgements()[0]);
  });

  it.each([
    "0",
    "-1",
    "1.5",
    "7abc",
    "9007199254740992",
  ])("CLI rejects invalid sequence %s before sending", async (sequence) => {
    expect(
      await runCli(["ack", sequence, "--consumer-id", "agent-a"], deps()),
    ).toBe(2);
    expect(acknowledgements()).toEqual([]);
  });

  it("CLI ack requires an explicit consumer even when the env is set", async () => {
    env.ROUGHDRAFT_CONSUMER_ID = "watch-agent";
    expect(await runCli(["ack", "7"], deps())).toBe(2);
    expect(acknowledgements()).toEqual([]);
  });

  it("CLI watch receives under the explicit consumer and preserves roundId", async () => {
    env.ROUGHDRAFT_CONSUMER_ID = "env-agent";
    expect(
      await runCli(
        ["watch", documentPath, "--consumer-id", "explicit-agent", "--json"],
        deps(),
      ),
    ).toBe(0);
    expect(JSON.parse(logs[0])).toMatchObject({
      consumerId: "explicit-agent",
      events: [{ roundId: "round-1" }],
      acknowledgements: [{ status: "received" }],
    });
    expect(acknowledgements()).toEqual([
      { sequence: 7, consumerId: "explicit-agent", status: "received" },
    ]);
  });

  it("CLI watch uses the environment consumer and gives the processed follow-up", async () => {
    env.ROUGHDRAFT_CONSUMER_ID = "env-agent";
    expect(await runCli(["watch", documentPath], deps())).toBe(0);
    expect(acknowledgements()[0]).toMatchObject({
      consumerId: "env-agent",
      status: "received",
    });
    expect(logs.join("\n")).toContain("roughdraft ack 7 --consumer-id");
    expect(logs.join("\n")).toContain("env-agent");
  });

  it("CLI watch generates a separate consumer for each invocation", async () => {
    await runCli(["watch", documentPath, "--json"], deps());
    await runCli(["watch", documentPath, "--json"], deps());
    const first = JSON.parse(logs[0]).consumerId;
    const second = JSON.parse(logs[1]).consumerId;
    expect(first).toEqual(expect.any(String));
    expect(second).not.toBe(first);
    expect(acknowledgements().map((a) => a.consumerId)).toEqual([
      first,
      second,
    ]);
  });

  it.each([
    "cli",
    "mcp",
  ])("%s preserves delivered events when received acknowledgement fails", async (client) => {
    ackFails = true;
    let result: unknown;
    if (client === "cli") {
      expect(await runCli(["watch", documentPath, "--json"], deps())).toBe(0);
      result = JSON.parse(logs[0]);
    } else {
      result = await callTool(
        "roughdraft_watch_review_events",
        { documentPath },
        env,
        fetchImpl,
      );
    }
    expect(result).toMatchObject({
      timedOut: false,
      events: [{ sequence: 7 }],
      consumerId: expect.any(String),
      warnings: [expect.stringContaining("ack connection lost")],
    });
    expect(acknowledgements()).toHaveLength(1);
    expect(acknowledgements()[0].status).toBe("received");
  });

  it.each([
    "cli",
    "mcp",
  ])("%s does not auto-ack on an old server", async (client) => {
    capable = false;
    if (client === "cli")
      expect(await runCli(["watch", documentPath, "--json"], deps())).toBe(0);
    else
      await callTool(
        "roughdraft_watch_review_events",
        { documentPath },
        env,
        fetchImpl,
      );
    expect(acknowledgements()).toEqual([]);
  });

  it("MCP history accepts deleted documents and explicit ack defaults to processed", async () => {
    fs.unlinkSync(documentPath);
    expect(
      await callTool(
        "roughdraft_get_review_history",
        { documentPath },
        env,
        fetchImpl,
      ),
    ).toEqual(history);
    expect(
      await callTool(
        "roughdraft_ack_review_event",
        { sequence: 7, consumerId: "mcp-agent" },
        env,
        fetchImpl,
      ),
    ).toMatchObject({
      sequence: 7,
      consumerId: "mcp-agent",
      status: "processed",
    });
  });

  it("MCP reads the active API registry", async () => {
    expect(
      await callTool("roughdraft_get_open_documents", {}, env, fetchImpl),
    ).toEqual({ documents: [{ documentPath }] });
    expect(requests.map((r) => r.pathname)).toContain("/api/reviews");
  });

  it("MCP falls back to the legacy registry when the saved server is offline", async () => {
    const record = new ReviewRegistry({ stateDir: dir }).register(documentPath);
    expect(
      await callTool("roughdraft_get_open_documents", {}, env, async () => {
        throw new TypeError("fetch failed");
      }),
    ).toMatchObject({ documents: [{ documentPath: record.documentPath }] });
    expect(fs.existsSync(path.join(dir, "roughdraft.sqlite"))).toBe(false);
  });

  it("MCP surfaces active registry errors instead of masking them with offline data", async () => {
    await expect(
      callTool(
        "roughdraft_get_open_documents",
        {},
        env,
        async () => new Response("failed", { status: 500 }),
      ),
    ).rejects.toThrow("HTTP 500");
  });

  it("CLI reports ack failures in human output without failing delivered feedback", async () => {
    ackFails = true;
    expect(
      await runCli(["watch", documentPath, "--consumer-id", "agent-a"], deps()),
    ).toBe(0);
    expect(errors.join("\n")).toContain("Warning:");
    expect(logs.join("\n")).toContain(
      "roughdraft ack 7 --consumer-id 'agent-a'",
    );
  });

  it("MCP watch prefers its consumer argument over environment and only receives", async () => {
    env.ROUGHDRAFT_CONSUMER_ID = "env-agent";
    expect(
      await callTool(
        "roughdraft_watch_review_events",
        { documentPath, consumerId: "tool-agent" },
        env,
        fetchImpl,
      ),
    ).toMatchObject({
      consumerId: "tool-agent",
      acknowledgements: [{ consumerId: "tool-agent", status: "received" }],
    });
    expect(acknowledgements()).toEqual([
      { consumerId: "tool-agent", sequence: 7, status: "received" },
    ]);
  });

  it("explicit CLI ack failures return nonzero instead of claiming processing", async () => {
    ackFails = true;
    expect(
      await runCli(["ack", "7", "--consumer-id", "agent-a", "--json"], deps()),
    ).toBe(1);
    expect(logs).toEqual([]);
    expect(errors.join("\n")).toContain("ack connection lost");
  });

  it("explicit history and ack reject unsupported old servers without writing", async () => {
    capable = false;
    expect(await runCli(["history", documentPath, "--json"], deps())).toBe(1);
    await expect(
      callTool(
        "roughdraft_ack_review_event",
        { sequence: 7, consumerId: "agent-a" },
        env,
        fetchImpl,
      ),
    ).rejects.toThrow("does not support");
    expect(acknowledgements()).toEqual([]);
  });

  it.each([
    null,
    "done",
    3,
  ])("MCP rejects invalid acknowledgement status %s before writing", async (status) => {
    await expect(
      callTool(
        "roughdraft_ack_review_event",
        { sequence: 7, consumerId: "agent-a", status },
        env,
        fetchImpl,
      ),
    ).rejects.toThrow("status must be");
    expect(acknowledgements()).toEqual([]);
  });

  it("MCP returns delivered events with a warning when capability discovery fails", async () => {
    const failingStatus: typeof fetch = (input, init) =>
      String(input).endsWith("/api/status")
        ? Promise.reject(new Error("status unavailable"))
        : fetchImpl(input, init);
    expect(
      await callTool(
        "roughdraft_watch_review_events",
        { documentPath },
        env,
        failingStatus,
      ),
    ).toMatchObject({
      events: [{ sequence: 7 }],
      warnings: [expect.stringContaining("status unavailable")],
    });
    expect(acknowledgements()).toEqual([]);
  });

  it("MCP advertises history, acknowledgement, and watch consumer ID through clean stdio", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk) => {
      written += chunk.toString();
    });
    startMcpServer({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      env,
      fetchImpl,
    });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    input.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    await new Promise((resolve) => setImmediate(resolve));
    const [header, payload] = written.split("\r\n\r\n");
    expect(header).toBe(`Content-Length: ${Buffer.byteLength(payload)}`);
    const tools = JSON.parse(payload).result.tools;
    expect(tools.map((t: { name: string }) => t.name)).toContain(
      "roughdraft_get_review_history",
    );
    expect(tools.map((t: { name: string }) => t.name)).toContain(
      "roughdraft_ack_review_event",
    );
    expect(
      tools.find(
        (t: { name: string }) => t.name === "roughdraft_watch_review_events",
      ).inputSchema.properties.consumerId,
    ).toEqual({ type: "string" });
    input.destroy();
    output.destroy();
  });
});
