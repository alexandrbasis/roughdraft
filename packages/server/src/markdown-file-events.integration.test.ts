import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const serverDirectory = fileURLToPath(new URL("..", import.meta.url));
const sourceEntry = fileURLToPath(new URL("./index.ts", import.meta.url));

it.each([
  "deleted",
  "unreadable",
])("keeps the daemon and SSE alive for a %s watched file and reports recovery and atomic saves", async (failure) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "roughdraft-file-events-"),
  );
  // Only the scheduling gap is controlled. The child uses the source app,
  // a real polling watcher, real files, and a real loopback SSE connection.
  const script = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import path from "node:path";
    import { createServer } from "node:http";
    import { createHash } from "node:crypto";
    import { createApp } from ${JSON.stringify(sourceEntry)};

    const directory = ${JSON.stringify(directory)};
    const failure = ${JSON.stringify(failure)};
    const projectDir = path.join(directory, "project");
    fs.mkdirSync(projectDir);
    const document = path.join(projectDir, "draft.md");
    const armFile = path.join(directory, "arm");
    fs.writeFileSync(document, "# Initial\\n");
    let watching;
    const ready = new Promise(resolve => { watching = resolve; });
    const watchFile = fs.watchFile.bind(fs);
    const unwatchFile = fs.unwatchFile.bind(fs);
    const listeners = new Map();
    let injected = false;
    fs.watchFile = (filename, options, listener) => {
      const wrapped = (current, previous) => {
        if (filename === document && current.nlink > 0 && fs.existsSync(armFile)) {
          fs.unlinkSync(armFile);
          fs.unlinkSync(document);
          if (failure === "unreadable") fs.mkdirSync(document);
          injected = true;
          const event = {
            ts: new Date().toISOString(),
            runId: process.env.THOUGHTFUL_SLOG_RUN_ID ?? "manual",
            source: "markdown-file-events.integration.test.ts",
            event: "watcher.stale-positive-stats",
            data: { nlink: current.nlink, exists: fs.existsSync(document) },
          };
          process.stdout.write(JSON.stringify(event) + "\\n");
          if (process.env.THOUGHTFUL_SLOG_FILE) {
            fs.appendFileSync(process.env.THOUGHTFUL_SLOG_FILE, JSON.stringify(event) + "\\n");
          }
        }
        listener(current, previous);
      };
      listeners.set(listener, wrapped);
      const watcher = watchFile(filename, options, wrapped);
      if (filename === document) watching();
      return watcher;
    };
    fs.unwatchFile = (filename, listener) => {
      unwatchFile(filename, listeners.get(listener) ?? listener);
      listeners.delete(listener);
    };

    const { app } = createApp({ projectDir, stateDirectory: path.join(directory, "state"), homeDir: directory });
    const server = createServer(app);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const baseUrl = "http://127.0.0.1:" + server.address().port;
    const response = await fetch(baseUrl + "/api/markdown-file/events?path=draft.md&projectPath=" + encodeURIComponent(projectDir), {
      signal: AbortSignal.timeout(6000),
    });
    assert.equal(response.status, 200);
    await ready;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    async function nextChange(expectedType = "change") {
      while (true) {
        let end;
        while ((end = buffer.indexOf("\\n\\n")) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (frame.startsWith("event: ")) {
            assert.equal(frame.split("\\n")[0], "event: " + expectedType);
            return JSON.parse(frame.split("\\ndata: ")[1]);
          }
        }
        const { done, value } = await reader.read();
        assert.equal(done, false, "SSE must remain connected");
        buffer += decoder.decode(value, { stream: true });
      }
    }
    async function expectContentVersion(content) {
      const hash = createHash("sha256").update(content).digest("hex");
      let event;
      do { event = await nextChange(); } while (!event.exists);
      assert.equal(event.path, "draft.md");
      assert.ok(event.version.endsWith(":" + hash), "SSE must identify current file content");
      return event.version;
    }

    fs.writeFileSync(armFile, "armed");
    fs.writeFileSync(document, "# Changed to trigger the real watcher\\n");
    const missing = await nextChange(failure === "deleted" ? "change" : "error");
    assert.equal(injected, true, "the stale-positive-stat race must have occurred");
    if (failure === "deleted") {
      assert.deepEqual(missing, { path: "draft.md", exists: false, version: null });
    } else {
      assert.deepEqual(missing, {
        path: "draft.md", error: "Unable to read Markdown file", code: "EISDIR",
      });
      fs.rmdirSync(document);
    }
    assert.equal((await fetch(baseUrl + "/api/status")).status, 200);

    const recreated = "# Recreated\\n";
    fs.writeFileSync(document, recreated);
    fs.utimesSync(document, 1700000000, 1700000000);
    const recreatedVersion = await expectContentVersion(recreated);
    const saved = "# Replaced!\\n";
    fs.writeFileSync(document + ".tmp", saved);
    fs.utimesSync(document + ".tmp", 1700000000, 1700000000);
    assert.equal(fs.statSync(document + ".tmp").size, fs.statSync(document).size);
    assert.equal(fs.statSync(document + ".tmp").mtimeMs, fs.statSync(document).mtimeMs);
    fs.renameSync(document + ".tmp", document);
    assert.notEqual(await expectContentVersion(saved), recreatedVersion);
    assert.equal((await fetch(baseUrl + "/api/status")).status, 200);
    fs.unlinkSync(document);
    assert.deepEqual(await nextChange(), { path: "draft.md", exists: false, version: null });
    assert.equal((await fetch(baseUrl + "/api/status")).status, 200);
    await reader.cancel();
    process.exit(0);
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: serverDirectory,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(
      code,
      `The source daemon must survive the file event race.\n${output}`,
    ).toBe(0);
    expect(output).toContain('"event":"watcher.stale-positive-stats"');
    if (failure === "unreadable") {
      expect(output).toContain("Failed to read watched Markdown file:");
      expect(output).toContain("EISDIR");
    }
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
