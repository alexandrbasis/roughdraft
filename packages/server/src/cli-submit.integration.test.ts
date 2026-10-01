import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createApp } from "./index";
import { writeMarkdownAtomically } from "./atomic-markdown";

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

it("submits agent editions through the CLI with version conflicts and review handoff", async () => {
  directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-cli-submit-")),
  );
  const documentPath = path.join(directory, "review.md");
  fs.writeFileSync(documentPath, "# Original\n");
  const { app } = createApp({
    stateDirectory: directory,
    projectDir: directory,
    serverRoot: root,
    staticDirPath: directory,
  });
  closeDatabase = () => app.locals.reviewDatabase.close();
  server = createServer(app);
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
  const env = {
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
      { cwd: root, env, timeout: 10_000 },
    );
  }
  async function cliWithStdin(input: string, ...args: string[]) {
    const script = `import { runCli } from ${JSON.stringify(path.join(root, "packages/server/src/cli.ts"))}; process.exit(await runCli(process.argv.slice(1)));`;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script, "--", ...args],
      { cwd: root, env },
    );
    let stdout = "";
    let stderr = "";
    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stdout += chunk));
    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end(input);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (code !== 0) throw new Error(`CLI exited ${code}: ${stderr}`);
    return stdout;
  }
  const read = async () =>
    JSON.parse((await cli("read", documentPath, "--json")).stdout);
  const first = await read();
  const editionPath = path.join(directory, "edition.md");
  fs.writeFileSync(editionPath, "# Agent one\n");
  const submit = await cli(
    "submit",
    documentPath,
    "--from",
    editionPath,
    "--expected-version",
    first.version,
    "--json",
  );
  expect(JSON.parse(submit.stdout)).toMatchObject({
    content: "# Agent one\n",
    editingState: "awaiting-review",
  });
  expect(fs.readFileSync(documentPath, "utf8")).toBe("# Agent one\n");
  const afterFirst = await read();
  expect(afterFirst.iterations).toMatchObject([
    { actor: "unknown" },
    { actor: "agent", number: 2 },
  ]);
  const retried = JSON.parse(
    (
      await cli(
        "submit",
        documentPath,
        "--from",
        editionPath,
        "--expected-version",
        first.version,
        "--json",
      )
    ).stdout,
  );
  expect(retried.retried).toBe(true);
  expect((await read()).iterations).toHaveLength(2);

  const completed = await fetch(
    new URL(
      `/api/review-events?projectPath=${encodeURIComponent(directory)}&path=review.md`,
      baseUrl,
    ),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  expect(completed.status).toBe(201);
  const reviewed = await read();
  expect(reviewed.editingState).toBe("completed");
  await expect(
    cli(
      "submit",
      documentPath,
      "--from",
      editionPath,
      "--expected-version",
      first.version,
    ),
  ).rejects.toMatchObject({ code: 1 });
  const pollUrl = new URL("/api/open-requests", baseUrl);
  pollUrl.searchParams.set("poll", "1");
  pollUrl.searchParams.set("clientId", "submit-test");
  pollUrl.searchParams.set("path", documentPath);
  expect(await (await fetch(pollUrl)).json()).toEqual({});
  const unchanged = JSON.parse(
    await cliWithStdin(
      "# Agent one\n",
      "submit",
      documentPath,
      "--from",
      "-",
      "--expected-version",
      reviewed.version,
      "--json",
    ),
  );
  expect(unchanged).toMatchObject({
    content: "# Agent one\n",
    editingState: "awaiting-review",
  });
  expect((await read()).iterations.at(-1)).toMatchObject({
    actor: "agent",
    number: 4,
  });
  expect(await (await fetch(pollUrl)).json()).toMatchObject({
    url: expect.stringContaining(unchanged.route),
  });
  const completedAgain = await fetch(
    new URL(
      `/api/review-events?projectPath=${encodeURIComponent(directory)}&path=review.md`,
      baseUrl,
    ),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  expect(completedAgain.status).toBe(201);
  const beforeSecond = await read();
  const second = JSON.parse(
    await cliWithStdin(
      "# Agent two\n",
      "submit",
      documentPath,
      "--from",
      "-",
      "--expected-version",
      beforeSecond.version,
      "--json",
    ),
  );
  expect(second).toMatchObject({
    content: "# Agent two\n",
    editingState: "awaiting-review",
  });
  expect((await read()).iterations.at(-1)).toMatchObject({
    actor: "agent",
    number: 6,
  });
  const draftResponse = await fetch(new URL("/api/reviews/drafts", baseUrl), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      documentPath,
      draft: {
        storageKey: "test",
        content: "# Human unfinished\n",
        baseContent: "# Agent two\n",
        baseVersion: second.version,
        revision: "r1",
        tabId: "test-tab",
        updatedAt: Date.now(),
      },
    }),
  });
  expect(draftResponse.status).toBe(200);
  fs.writeFileSync(editionPath, "# Agent three\n");
  await expect(
    cli(
      "submit",
      documentPath,
      "--from",
      editionPath,
      "--expected-version",
      second.version,
    ),
  ).rejects.toMatchObject({ code: 1 });
  expect(fs.readFileSync(documentPath, "utf8")).toBe("# Agent two\n");
}, 40_000);

it("restores a pending review after an agent write committed before registration", () => {
  directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-agent-recovery-")),
  );
  const documentPath = path.join(directory, "review.md");
  fs.writeFileSync(documentPath, "# Original\n");
  const options = {
    stateDirectory: directory,
    projectDir: directory,
    serverRoot: root,
    staticDirPath: directory,
  };
  const first = createApp(options);
  const db = first.app.locals.reviewDatabase;
  const writeId = db.prepareWrite(
    documentPath,
    "# Agent\n",
    undefined,
    "agent",
  );
  writeMarkdownAtomically(documentPath, "# Agent\n", {
    expectedContent: "# Original\n",
  });
  db.finishWrite(writeId);
  db.close();

  const restarted = createApp(options);
  closeDatabase = () => restarted.app.locals.reviewDatabase.close();
  const recovered = restarted.app.locals.reviewDatabase;
  expect(recovered.listRecords()).toMatchObject([
    { documentPath, status: "pending" },
  ]);
  expect(recovered.documentEditingState(documentPath)).toBe("awaiting-review");
  expect(recovered.completedIterations(documentPath).at(-1)).toMatchObject({
    actor: "agent",
    content: "# Agent\n",
  });
});

it("restores a pending review after an unchanged agent submission committed before registration", () => {
  directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-unchanged-recovery-")),
  );
  const documentPath = path.join(directory, "review.md");
  fs.writeFileSync(documentPath, "# Original\n");
  const options = {
    stateDirectory: directory,
    projectDir: directory,
    serverRoot: root,
    staticDirPath: directory,
  };
  const first = createApp(options);
  const db = first.app.locals.reviewDatabase;
  db.completedIterations(documentPath);
  db.completeUnchangedAgentSubmission(documentPath, "# Original\n");
  expect(db.completedIterations(documentPath).at(-1)).toMatchObject({
    actor: "agent",
    content: "# Original\n",
  });
  expect(db.listRecords()).toEqual([]);
  db.close();

  const restarted = createApp(options);
  closeDatabase = () => restarted.app.locals.reviewDatabase.close();
  const recovered = restarted.app.locals.reviewDatabase;
  expect(recovered.listRecords()).toMatchObject([
    { documentPath, status: "pending" },
  ]);
  expect(recovered.documentEditingState(documentPath)).toBe("awaiting-review");
});
