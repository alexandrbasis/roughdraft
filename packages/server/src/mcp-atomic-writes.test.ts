import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractRoughdraftReviewIndex } from "@roughdraft/rfm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callTool } from "./mcp";

const operations = [
  {
    tool: "roughdraft_reply_to_comment",
    args: { parentId: "c1", message: "Added the evidence.", author: "AI" },
    expectedItem: {
      kind: "reply",
      parentId: "c1",
      text: "Added the evidence.",
    },
  },
  {
    tool: "roughdraft_mark_resolved",
    args: { targetId: "c1", summary: "Evidence verified." },
    expectedItem: { id: "c1", status: "resolved" },
  },
];

describe.each(operations)("$tool atomic Markdown writes", (operation) => {
  let directory: string;
  let documentPath: string;
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  // Mixed bytes catch backups reconstructed from decoded Markdown as well as
  // missing backups. The invalid UTF-8 byte is ordinary prose, outside markup.
  const original = Buffer.concat([
    Buffer.from(
      '\uFEFF# Draft\r\n\r\nשלום café\r\n{>>Needs proof<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}\r\n',
    ),
    Buffer.from([0xff, 0x0d, 0x0a]),
  ]);

  beforeEach(() => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "roughdraft-mcp-atomic-"),
    );
    documentPath = path.join(directory, "draft.md");
    stateDir = path.join(directory, "state");
    env = { ROUGHDRAFT_STATE_FILE: path.join(stateDir, "server.json") };
    fs.writeFileSync(documentPath, original);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("preserves original bytes in stateDir/markdown-backups/<sha256>.md when updating", async () => {
    await expect(
      callTool(operation.tool, { documentPath, ...operation.args }, env, fetch),
    ).resolves.toMatchObject({
      ok: true,
      backupPath: expect.any(String),
      historyRecorded: false,
    });

    const updated = fs.readFileSync(documentPath, "utf8");
    expect(extractRoughdraftReviewIndex(updated).items).toEqual(
      expect.arrayContaining([expect.objectContaining(operation.expectedItem)]),
    );
    const digest = createHash("sha256").update(original).digest("hex");
    const backupPath = path.join(stateDir, "markdown-backups", `${digest}.md`);
    expect(
      fs.existsSync(backupPath),
      `Missing original backup: ${backupPath}`,
    ).toBe(true);
    expect(fs.readFileSync(backupPath)).toEqual(original);
  });

  it("rejects content changed after the original read and preserves the competing edit", async () => {
    const competing = Buffer.from(
      "# Saved by another editor\n\nKeep this edit.\n",
    );
    const readFileSync = fs.readFileSync.bind(fs);
    let edited = false;
    // Keep MCP, RFM, and the atomic writer real. Only schedule an external edit
    // after MCP obtains its original bytes, before it can save the update.
    vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      const contents = readFileSync(...args);
      if (!edited && args[0] === documentPath) {
        edited = true;
        fs.writeFileSync(documentPath, competing);
      }
      return contents;
    });

    let failure: unknown;
    try {
      await callTool(
        operation.tool,
        { documentPath, ...operation.args },
        env,
        fetch,
      );
    } catch (error) {
      failure = error;
    }

    expect(edited, "The competing edit must run during the MCP read").toBe(
      true,
    );
    expect
      .soft(
        fs.readFileSync(documentPath).equals(competing),
        "The competing edit must remain byte-for-byte intact",
      )
      .toBe(true);
    expect(failure).toMatchObject({ code: "MARKDOWN_CONFLICT" });
  });
});
