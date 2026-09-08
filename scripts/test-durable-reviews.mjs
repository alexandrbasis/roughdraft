#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const scriptPath = fileURLToPath(import.meta.url);
const sourceRoot = path.resolve(path.dirname(scriptPath), "..");
const cliPath = path.join(sourceRoot, "packages/server/bin/roughdraft.mjs");
const jsonHeaders = { "Content-Type": "application/json" };
const requestTimeoutMs = 15_000;
const waitTimeoutMs = 15_000;

const ownedCliChildren = new Set();
const ownedDaemons = new Map();

function commandDescription(args) {
  return `node ${path.relative(sourceRoot, cliPath)} ${args.join(" ")}`;
}

function spawnCli(args, env = {}) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      ROUGHDRAFT_NO_OPEN: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  ownedCliChildren.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      ownedCliChildren.delete(child);
      resolve({ code, signal, stdout, stderr });
    });
  });

  return { child, result };
}

async function runCli(args, env = {}, timeoutMs = waitTimeoutMs) {
  const invocation = spawnCli(args, env);
  let timeout;
  try {
    const outcome = await Promise.race([
      invocation.result,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          invocation.child.kill("SIGTERM");
          reject(new Error(`Timed out running ${commandDescription(args)}`));
        }, timeoutMs);
      }),
    ]);
    if (outcome.code !== 0) {
      throw new Error(
        `${commandDescription(args)} exited ${outcome.code ?? outcome.signal}\n` +
          `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`,
      );
    }
    return outcome;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonOutput(outcome, args) {
  try {
    return JSON.parse(outcome.stdout.trim());
  } catch (error) {
    throw new Error(
      `Expected JSON from ${commandDescription(args)}: ${error.message}\n` +
        `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`,
    );
  }
}

async function availablePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address === "object", "ephemeral port missing");
  const port = address.port;
  await new Promise((resolve, reject) => {
    listener.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function apiUrl(port, pathname) {
  return `http://127.0.0.1:${port}${pathname}`;
}

async function fetchJson(url, init = {}, timeoutMs = requestTimeoutMs) {
  const response = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text.length > 0 ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${error.message}\n${text}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text}`);
  }
  return payload;
}

async function statusAt(port) {
  try {
    return await fetchJson(apiUrl(port, "/api/status"), {}, 750);
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return null;
    }
    if (/^HTTP 5\d\d/.test(error.message) || error.cause?.code) {
      return null;
    }
    return null;
  }
}

async function eventually(label, check, timeoutMs = waitTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(75);
  }
  throw new Error(
    `${label} did not become true${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function readState(stateDir) {
  return JSON.parse(
    await fs.readFile(path.join(stateDir, "server.json"), "utf8"),
  );
}

async function startServer(stateDir, preferredPort) {
  const args = [
    "start",
    "--json",
    "--state-dir",
    stateDir,
    "--port",
    String(preferredPort),
  ];
  const outcome = await runCli(args);
  const payload = parseJsonOutput(outcome, args);
  assert.equal(payload.running, true, "start did not report a running server");
  const state = await readState(stateDir);
  assert.equal(payload.pid, state.pid);
  assert.equal(payload.port, state.port);
  assert.equal(payload.managed, true);
  ownedDaemons.set(state.pid, state.port);
  await eventually(`server ${state.pid} is reachable`, async () => {
    const status = await statusAt(state.port);
    return status?.pid === state.pid && status.serverRoot === sourceRoot;
  });
  return state;
}

async function stopOwnedDaemon(pid, port) {
  const status = await statusAt(port);
  if (!status || status.pid !== pid || status.serverRoot !== sourceRoot) {
    return false;
  }

  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = await statusAt(port);
    if (!current) return true;
    if (current.pid !== pid || current.serverRoot !== sourceRoot) return false;
    await sleep(75);
  }

  const current = await statusAt(port);
  if (!current) return true;
  if (current.pid !== pid || current.serverRoot !== sourceRoot) return false;
  process.kill(pid, "SIGKILL");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!(await statusAt(port))) return true;
    await sleep(75);
  }
  return false;
}

async function createFixtures(tempDir, count) {
  const projects = [];
  for (let index = 0; index < count; index += 1) {
    const projectDir = path.join(tempDir, `project-${index + 1}`);
    const documentPath = path.join(projectDir, "draft.md");
    await fs.mkdir(path.join(projectDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "package.json"),
      `${JSON.stringify({ name: "durable-review-fixture" })}\n`,
    );
    await fs.writeFile(documentPath, "# Durable review\n\nFixture content.\n");
    const canonicalProjectPath = await fs.realpath(projectDir);
    const canonicalDocumentPath = await fs.realpath(documentPath);
    projects.push({
      documentPath: canonicalDocumentPath,
      projectPath: canonicalProjectPath,
      relativePath: "draft.md",
    });
  }
  return projects;
}

async function listReviews(port) {
  return fetchJson(apiUrl(port, "/api/reviews"));
}

async function emitCompleted(port, fixture) {
  return fetchJson(apiUrl(port, "/api/review-events"), {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      projectPath: fixture.projectPath,
      path: fixture.relativePath,
    }),
  });
}

async function watchHttp(port, fixture) {
  return fetchJson(
    apiUrl(port, "/api/review-events/watch"),
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        projectPath: fixture.projectPath,
        path: fixture.relativePath,
        fromNow: false,
        afterSequence: 0,
        batchWindowSeconds: 0,
        timeoutSeconds: 10,
      }),
    },
    12_000,
  );
}

async function waitForReview(port, documentPath, predicate) {
  return eventually(`review ${documentPath}`, async () => {
    const records = await listReviews(port);
    const record = records.find(
      (candidate) => candidate.documentPath === documentPath,
    );
    return record && predicate(record) ? record : null;
  });
}

async function main() {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "roughdraft-durable-reviews-"),
  );
  let stateDir;
  let cleanupSafe = true;
  try {
    stateDir = path.join(tempDir, "state");
    const fixtures = await createFixtures(tempDir, 9);
    const preferredPort = await availablePort();

    const coldOpens = await Promise.all(
      fixtures.slice(0, 8).map(async (fixture) => {
        const args = [
          "open",
          fixture.documentPath,
          "--json",
          "--no-open",
          "--no-watch",
          "--state-dir",
          stateDir,
          "--port",
          String(preferredPort),
        ];
        const outcome = await runCli(args);
        return parseJsonOutput(outcome, args);
      }),
    );

    const coldState = await readState(stateDir);
    assert.ok(coldOpens.every((payload) => payload.opened === true));
    assert.equal(
      new Set(coldOpens.map((payload) => payload.serverUrl)).size,
      1,
      "cold opens did not converge on one server URL",
    );
    ownedDaemons.set(coldState.pid, coldState.port);
    await eventually("cold server is reachable", async () => {
      const status = await statusAt(coldState.port);
      return status?.pid === coldState.pid && status.serverRoot === sourceRoot;
    });

    const coldRecords = await waitForReview(
      coldState.port,
      fixtures[7].documentPath,
      (record) => record.status === "pending",
    );
    const allColdRecords = await listReviews(coldState.port);
    assert.equal(allColdRecords.length, 8);
    assert.equal(
      new Set(allColdRecords.map((record) => record.documentPath)).size,
      8,
    );
    assert.equal(new Set(allColdRecords.map((record) => record.route)).size, 8);
    assert.ok(
      allColdRecords.every((record) => record.relativePath === "draft.md"),
    );
    assert.ok(
      allColdRecords.every((record) => record.title === "Durable review"),
    );
    assert.equal(coldRecords.watcherCount, 0);

    const httpWatchers = allColdRecords.flatMap((record) => {
      const fixture = fixtures.find(
        (candidate) => candidate.documentPath === record.documentPath,
      );
      assert.ok(fixture);
      return [0, 1, 2].map(() => ({
        fixture,
        promise: watchHttp(coldState.port, fixture),
      }));
    });
    await eventually("all 24 HTTP watchers are attached", async () => {
      const records = await listReviews(coldState.port);
      return records.every((record) => record.watcherCount === 3);
    });

    const httpResults = await Promise.all(
      allColdRecords.map((record) => {
        const fixture = fixtures.find(
          (candidate) => candidate.documentPath === record.documentPath,
        );
        assert.ok(fixture);
        return emitCompleted(coldState.port, fixture);
      }),
    );
    assert.equal(httpResults.length, 8);
    const watcherResults = await Promise.all(
      httpWatchers.map(({ promise }) => promise),
    );
    assert.equal(watcherResults.length, 24);
    for (let index = 0; index < watcherResults.length; index += 1) {
      const result = watcherResults[index];
      assert.equal(result.timedOut, false);
      assert.equal(result.events?.length, 1);
      assert.equal(result.events[0].type, "review.completed");
      const expectedFixture = httpWatchers[index].fixture;
      assert.equal(result.events[0].documentPath, expectedFixture.documentPath);
      assert.equal(result.events[0].projectPath, expectedFixture.projectPath);
    }

    const completedRecords = await eventually(
      "all cold reviews complete",
      async () => {
        const records = await listReviews(coldState.port);
        return records.length === 8 &&
          records.every((record) => record.status === "completed")
          ? records
          : null;
      },
    );
    assert.equal(completedRecords.length, 8);
    const sqliteHeader = (
      await fs.readFile(path.join(stateDir, "roughdraft.sqlite"))
    )
      .subarray(0, 16)
      .toString();
    assert.equal(sqliteHeader, "SQLite format 3\0");

    const restartFixture = fixtures[8];
    const restartOpenArgs = [
      "open",
      restartFixture.documentPath,
      "--json",
      "--no-open",
      "--no-watch",
      "--state-dir",
      stateDir,
      "--port",
      String(coldState.port),
    ];
    await runCli(restartOpenArgs);
    await waitForReview(
      coldState.port,
      restartFixture.documentPath,
      (record) => record.status === "pending",
    );

    const watchArgs = [
      "watch",
      restartFixture.documentPath,
      "--json",
      "--timeout",
      "12",
      "--batch-window",
      "0",
      "--state-dir",
      stateDir,
    ];
    const watchProcess = spawnCli(watchArgs, {
      ROUGHDRAFT_PORT: String(coldState.port),
    });
    await waitForReview(
      coldState.port,
      restartFixture.documentPath,
      (record) => record.watcherCount === 1,
    );

    const oldPid = coldState.pid;
    assert.equal(
      await stopOwnedDaemon(oldPid, coldState.port),
      true,
      "could not stop owned daemon",
    );
    const restartedState = await eventually(
      "watch callback restarts the daemon",
      async () => {
        try {
          const state = await readState(stateDir);
          const status = await statusAt(state.port);
          return state.pid !== oldPid &&
            status?.pid === state.pid &&
            status.serverRoot === sourceRoot
            ? state
            : null;
        } catch {
          return null;
        }
      },
    );
    ownedDaemons.set(restartedState.pid, restartedState.port);
    assert.equal(
      restartedState.port,
      coldState.port,
      "restart unexpectedly changed the port",
    );

    await emitCompleted(restartedState.port, restartFixture);
    const watchOutcome = await Promise.race([
      watchProcess.result,
      sleep(waitTimeoutMs).then(() => {
        throw new Error(
          "attached CLI watch did not finish after daemon restart",
        );
      }),
    ]);
    assert.equal(watchOutcome.code, 0, watchOutcome.stderr);
    const watchPayload = parseJsonOutput(watchOutcome, watchArgs);
    assert.equal(watchPayload.timedOut, false);
    assert.equal(watchPayload.events?.length, 1);
    assert.equal(
      watchPayload.events[0].documentPath,
      restartFixture.documentPath,
    );
    assert.equal(watchPayload.events[0].type, "review.completed");

    const beforeFinalRestart = await readState(stateDir);
    assert.equal(
      await stopOwnedDaemon(beforeFinalRestart.pid, beforeFinalRestart.port),
      true,
    );
    const finalState = await startServer(stateDir, beforeFinalRestart.port);
    assert.notEqual(finalState.pid, beforeFinalRestart.pid);
    const persistedRecords = await listReviews(finalState.port);
    assert.equal(persistedRecords.length, 9);
    assert.ok(
      persistedRecords.every((record) => record.status === "completed"),
    );

    const replayArgs = [
      "watch",
      restartFixture.documentPath,
      "--json",
      "--replay",
      "--timeout",
      "4",
      "--batch-window",
      "0",
      "--state-dir",
      stateDir,
    ];
    const replayOutcome = await runCli(replayArgs, {
      ROUGHDRAFT_PORT: String(finalState.port),
    });
    const replayPayload = parseJsonOutput(replayOutcome, replayArgs);
    assert.equal(replayPayload.timedOut, false);
    assert.equal(replayPayload.events?.length, 1);
    assert.equal(
      replayPayload.events[0].documentPath,
      restartFixture.documentPath,
    );
    assert.equal(replayPayload.events[0].type, "review.completed");

    console.log(
      `durable reviews integration passed: one cold PID, 8 isolated records, 24 isolated watchers, restart recovery, and persisted replay (${finalState.pid})`,
    );
  } finally {
    const children = [...ownedCliChildren];
    for (const child of children) {
      child.kill("SIGTERM");
    }
    await Promise.allSettled(
      children.map(
        (child) =>
          new Promise((resolve) => {
            child.once("close", resolve);
          }),
      ),
    );
    if (stateDir) {
      try {
        const state = await readState(stateDir);
        if (!ownedDaemons.has(state.pid))
          ownedDaemons.set(state.pid, state.port);
      } catch {}
    }
    for (const port of new Set(ownedDaemons.values())) {
      try {
        const current = await statusAt(port);
        if (!current) continue;
        if (
          current.serverRoot !== sourceRoot ||
          !ownedDaemons.has(current.pid)
        ) {
          cleanupSafe = false;
          continue;
        }
        const stopped = await stopOwnedDaemon(current.pid, port);
        if (!stopped && (await statusAt(port))) cleanupSafe = false;
      } catch {
        cleanupSafe = false;
      }
    }
    if (cleanupSafe) {
      await fs.rm(tempDir, { recursive: true, force: true });
    } else {
      console.error(`left integration state for safety: ${tempDir}`);
    }
  }
}

await main();
