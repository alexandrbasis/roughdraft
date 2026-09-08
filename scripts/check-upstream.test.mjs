import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFile = promisify(execFileCallback);
const gitCommand = process.platform === "win32" ? "git.exe" : "git";
const scriptPath = fileURLToPath(
  new URL("./check-upstream.mjs", import.meta.url),
);
const temporaryDirectories = [];

async function run(command, args, options = {}) {
  return execFile(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
}

async function git(cwd, args) {
  return run(gitCommand, args, { cwd });
}

async function initRepository(prefix, { bare = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  temporaryDirectories.push(directory);
  await git(directory, [
    "init",
    "--quiet",
    ...(bare ? ["--bare"] : ["--initial-branch=main"]),
  ]);
  if (!bare) {
    await git(directory, ["config", "user.name", "Fixture User"]);
    await git(directory, ["config", "user.email", "fixture@example.test"]);
  }
  return directory;
}

async function commit(cwd, filename, contents, message) {
  await writeFile(path.join(cwd, filename), contents);
  await git(cwd, ["add", "--", filename]);
  await git(cwd, ["commit", "--quiet", "-m", message]);
}

async function createFixture({
  upstreamChange = false,
  forkChange = false,
} = {}) {
  const remote = await initRepository("check-upstream-remote", { bare: true });
  const upstreamWorktree = await initRepository("check-upstream-source");
  await git(upstreamWorktree, ["remote", "add", "origin", remote]);
  await commit(upstreamWorktree, "base.txt", "base\n", "base");
  await git(upstreamWorktree, ["push", "--quiet", "origin", "main"]);

  const fork = await initRepository("check-upstream-fork");
  await git(fork, ["remote", "add", "origin", remote]);
  await git(fork, ["fetch", "--quiet", "origin", "main"]);
  await git(fork, ["reset", "--quiet", "--hard", "FETCH_HEAD"]);
  if (forkChange) {
    await commit(fork, "fork.txt", "fork\n", "fork change");
  }
  if (upstreamChange) {
    await commit(
      upstreamWorktree,
      "upstream.txt",
      "upstream\n",
      "upstream change",
    );
    await git(upstreamWorktree, ["push", "--quiet", "origin", "main"]);
  }

  return { fork, remote };
}

async function runCli(fork, args) {
  try {
    const result = await run(process.execPath, [scriptPath, ...args], {
      cwd: fork,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

function reportFrom(result) {
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function assertReport({ upstreamChange, forkChange }, expected) {
  const fixture = await createFixture({ upstreamChange, forkChange });
  const workingFilePath = path.join(fixture.fork, "working-file.txt");
  await writeFile(workingFilePath, "keep this working file\n");
  const headBefore = (
    await git(fixture.fork, ["rev-parse", "HEAD"])
  ).stdout.trim();
  const upstreamSha = (
    await git(fixture.remote, ["rev-parse", "refs/heads/main"])
  ).stdout.trim();
  const statusBefore = (
    await git(fixture.fork, ["status", "--porcelain", "--untracked-files=all"])
  ).stdout;
  const fetchHeadPath = path.resolve(
    fixture.fork,
    (
      await git(fixture.fork, ["rev-parse", "--git-path", "FETCH_HEAD"])
    ).stdout.trim(),
  );
  const fetchHeadBefore = await readFile(fetchHeadPath, "utf8");
  const result = await runCli(fixture.fork, [
    "--remote",
    fixture.remote,
    "--json",
  ]);
  const report = reportFrom(result);

  assert.equal(report.ahead, expected.ahead);
  assert.equal(report.behind, expected.behind);
  assert.equal(report.containsUpstream, expected.containsUpstream);
  assert.equal(report.nextAction, expected.nextAction);
  assert.equal(report.remote, fixture.remote);
  assert.equal(report.branch, "main");
  assert.equal(report.upstreamSha, upstreamSha);
  assert.equal(report.forkHead, headBefore);
  assert.equal(
    (await git(fixture.fork, ["rev-parse", "HEAD"])).stdout.trim(),
    headBefore,
  );
  assert.equal(await readFile(fetchHeadPath, "utf8"), fetchHeadBefore);
  assert.equal(
    await readFile(workingFilePath, "utf8"),
    "keep this working file\n",
  );
  assert.equal(
    (
      await git(fixture.fork, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ])
    ).stdout,
    statusBefore,
  );
}

test.after(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function concurrentTest(name, callback) {
  return test(name, { concurrency: true }, callback);
}

concurrentTest("reports equal upstream and fork histories", async () => {
  await assertReport(
    { upstreamChange: false, forkChange: false },
    {
      ahead: 0,
      behind: 0,
      containsUpstream: true,
      nextAction: "No action needed; the fork matches the upstream branch.",
    },
  );
});

concurrentTest("reports a fork that is ahead of upstream", async () => {
  await assertReport(
    { upstreamChange: false, forkChange: true },
    {
      ahead: 1,
      behind: 0,
      containsUpstream: true,
      nextAction:
        "Review the fork-only commits; upstream is already contained.",
    },
  );
});

concurrentTest("reports a fork that is behind upstream", async () => {
  await assertReport(
    { upstreamChange: true, forkChange: false },
    {
      ahead: 0,
      behind: 1,
      containsUpstream: false,
      nextAction:
        "Review upstream changes, then merge or rebase them into the fork.",
    },
  );
});

concurrentTest("reports diverged upstream and fork histories", async () => {
  await assertReport(
    { upstreamChange: true, forkChange: true },
    {
      ahead: 1,
      behind: 1,
      containsUpstream: false,
      nextAction:
        "Review the divergent histories, then reconcile upstream changes before publishing.",
    },
  );
});

concurrentTest("supports help without touching a checkout", async () => {
  const result = await runCli(process.cwd(), ["--help"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /--remote <path-or-url>/);
  assert.match(result.stdout, /--help/);
  assert.equal(result.stderr, "");
});

concurrentTest(
  "fails clearly when the upstream remote cannot be fetched",
  async () => {
    const fixture = await createFixture();
    const headBefore = (
      await git(fixture.fork, ["rev-parse", "HEAD"])
    ).stdout.trim();
    const result = await runCli(fixture.fork, [
      "--remote",
      path.join(fixture.remote, "missing.git"),
    ]);

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /check-upstream failed: git fetch failed/);
    assert.equal(
      (await git(fixture.fork, ["rev-parse", "HEAD"])).stdout.trim(),
      headBefore,
    );
  },
);
