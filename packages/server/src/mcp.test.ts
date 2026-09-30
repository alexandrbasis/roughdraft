import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callTool } from "./mcp";

describe("mcp", () => {
  let tempDir: string;
  let stateFile: string;
  let projectDir: string;
  let documentPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-mcp-"));
    projectDir = path.join(tempDir, "project");
    stateFile = path.join(tempDir, "state", "server.json");
    documentPath = path.join(projectDir, "draft.md");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ url: "http://localhost:7373", port: 7373 }),
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses bounded polls when no timeout is supplied and preserves explicit timeouts", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let watchCount = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      requestBodies.push(body);
      watchCount += 1;
      if (body.timeoutSeconds === 0) {
        return new Response(
          JSON.stringify({ events: [], timedOut: true, nextSequence: 1 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          events: [{ type: "review.completed", documentPath }],
          timedOut: false,
          nextSequence: 2,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );
    await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir, timeoutSeconds: 5 },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );

    expect(requestBodies[0]).toMatchObject({
      projectPath: projectDir,
      path: "draft.md",
      batchWindowSeconds: 0.25,
      fromNow: true,
      timeoutSeconds: 0,
    });
    expect(requestBodies[1]).toMatchObject({
      afterSequence: 0,
      fromNow: false,
      timeoutSeconds: 240,
    });
    expect(requestBodies[2]).toMatchObject({
      fromNow: true,
      timeoutSeconds: 0,
    });
    expect(requestBodies[3]).toMatchObject({
      timeoutSeconds: 5,
    });
    expect(watchCount).toBe(4);
  });

  it("re-polls after a bounded timeout and carries the previous sequence", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let watchCount = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      requestBodies.push(body);
      watchCount += 1;

      if (watchCount === 1) {
        return new Response(
          JSON.stringify({ events: [], timedOut: true, nextSequence: 1 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (watchCount === 2) {
        return new Response(
          JSON.stringify({ events: [], timedOut: true, nextSequence: 2 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          events: [{ documentPath, type: "review.completed" }],
          timedOut: false,
          nextSequence: 3,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );

    expect(result).toMatchObject({ timedOut: false });
    expect(requestBodies).toHaveLength(3);
    expect(requestBodies[1]).toMatchObject({
      afterSequence: 0,
      fromNow: false,
      timeoutSeconds: 240,
    });
    expect(requestBodies[2]).toMatchObject({
      afterSequence: 1,
      fromNow: false,
      timeoutSeconds: 240,
    });
  });

  it("keeps watching a live server through a temporary status probe failure", async () => {
    const trackedState = {
      url: "http://localhost:7376",
      port: 7376,
      pid: process.pid,
      startedAt: "2026-09-30T00:00:00.000Z",
    };
    fs.writeFileSync(stateFile, JSON.stringify(trackedState));
    let watchAttempts = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.pathname === "/api/status") {
        if (watchAttempts === 1) {
          throw new Error("temporary localhost probe failure");
        }
        return new Response(
          JSON.stringify({
            backend: "local-files",
            port: trackedState.port,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname === "/api/review-events/watch") {
        watchAttempts += 1;
        if (watchAttempts === 1) {
          const error = new TypeError("fetch failed") as TypeError & {
            cause?: { code?: string };
          };
          error.cause = { code: "ECONNREFUSED" };
          throw error;
        }
        return new Response(
          JSON.stringify({
            events: [{ documentPath, type: "review.completed" }],
            timedOut: false,
            nextSequence: 1,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    };

    const result = await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );

    expect(result).toMatchObject({
      timedOut: false,
      events: [{ documentPath, type: "review.completed" }],
    });
    expect(watchAttempts).toBe(2);
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8"))).toEqual(
      trackedState,
    );
  });

  it("returns overall comments from review watch events unchanged", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          events: [
            {
              documentPath,
              type: "review.completed",
              overallComment: "Please prioritize the CLI contract.",
            },
          ],
          timedOut: false,
          nextSequence: 2,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );

    const result = await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );

    expect(result).toMatchObject({
      events: [
        {
          overallComment: "Please prioritize the CLI contract.",
        },
      ],
    });
  });

  it("does not write a reply when the message contains a CriticMarkup close delimiter", async () => {
    const original =
      '# Draft\n\n{>>Needs proof<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}\n';
    fs.writeFileSync(documentPath, original);

    await expect(
      callTool(
        "roughdraft_reply_to_comment",
        {
          documentPath,
          parentId: "c1",
          message: "This closes early <<} and breaks parsing.",
        },
        { ROUGHDRAFT_STATE_FILE: stateFile },
      ),
    ).rejects.toThrow(/CriticMarkup close delimiter/);

    expect(fs.readFileSync(documentPath, "utf8")).toBe(original);
  });
});
