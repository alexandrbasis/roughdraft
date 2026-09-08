#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
const GIT_COMMAND = process.platform === "win32" ? "git.exe" : "git";
const DEFAULT_REMOTE = "https://github.com/Lex-Inc/roughdraft.git";
const DEFAULT_BRANCH = "main";

const HELP = `Usage: node scripts/check-upstream.mjs [options]

Inspect this checkout against the upstream Roughdraft branch without changing
the checkout or working files.

Options:
  --remote <path-or-url>  Upstream Git remote (default: ${DEFAULT_REMOTE})
  --branch <name>         Upstream branch (default: ${DEFAULT_BRANCH})
  --json                  Print the report as JSON
  -h, --help              Show this help
`;

class CheckUpstreamError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "CheckUpstreamError";
  }
}

async function runGit(args, options = {}) {
  try {
    const result = await execFile(GIT_COMMAND, args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const exitCode = typeof error.code === "number" ? error.code : null;
    if (options.allowExitCodes?.includes(exitCode)) {
      return {
        exitCode,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      };
    }

    const detail = String(error.stderr ?? error.message ?? "git failed").trim();
    throw new CheckUpstreamError(
      detail ? `git ${args[0]} failed: ${detail}` : `git ${args[0]} failed`,
      { cause: error },
    );
  }
}

function outputValue(value) {
  return value.trim();
}

function branchRef(branch) {
  const normalized = branch.trim().replace(/^refs\/heads\//, "");
  if (!normalized || normalized.includes("..")) {
    throw new CheckUpstreamError(
      "Upstream branch must be a non-empty branch name",
    );
  }
  return `refs/heads/${normalized}`;
}

function parseAheadBehind(output) {
  const parts = outputValue(output).split(/\s+/).map(Number);
  if (parts.length !== 2 || parts.some((part) => !Number.isInteger(part))) {
    throw new CheckUpstreamError(
      "git rev-list returned an invalid ahead/behind count",
    );
  }
  return { ahead: parts[0], behind: parts[1] };
}

function nextAction({ ahead, behind, containsUpstream }) {
  if (ahead === 0 && behind === 0) {
    return "No action needed; the fork matches the upstream branch.";
  }
  if (containsUpstream) {
    return "Review the fork-only commits; upstream is already contained.";
  }
  if (ahead === 0) {
    return "Review upstream changes, then merge or rebase them into the fork.";
  }
  return "Review the divergent histories, then reconcile upstream changes before publishing.";
}

export function formatReport(report) {
  return [
    `Upstream remote: ${report.remote}`,
    `Upstream branch: ${report.branch}`,
    `Upstream SHA: ${report.upstreamSha}`,
    `Fork HEAD: ${report.forkHead}`,
    `Ahead: ${report.ahead}`,
    `Behind: ${report.behind}`,
    `Contains upstream: ${report.containsUpstream ? "yes" : "no"}`,
    `Next action: ${report.nextAction}`,
  ].join("\n");
}

export async function checkUpstream(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const remote = options.remote ?? DEFAULT_REMOTE;
  const branch = options.branch ?? DEFAULT_BRANCH;
  const remoteBranch = branchRef(branch);
  const rootResult = await runGit(["rev-parse", "--show-toplevel"], { cwd });
  const repoRoot = outputValue(rootResult.stdout);
  const headResult = await runGit(["rev-parse", "HEAD"], { cwd: repoRoot });
  const forkHead = outputValue(headResult.stdout);
  const tempRef = `refs/roughdraft/check-upstream/${process.pid}-${Date.now()}-${randomUUID()}`;
  let primaryError;
  let cleanupError;
  let report;

  try {
    await runGit(
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--force",
        "--",
        remote,
        `+${remoteBranch}:${tempRef}`,
      ],
      { cwd: repoRoot },
    );
    const upstreamResult = await runGit(["rev-parse", tempRef], {
      cwd: repoRoot,
    });
    const upstreamSha = outputValue(upstreamResult.stdout);
    const aheadBehindResult = await runGit(
      ["rev-list", "--left-right", "--count", `${forkHead}...${upstreamSha}`],
      { cwd: repoRoot },
    );
    const { ahead, behind } = parseAheadBehind(aheadBehindResult.stdout);
    const containsResult = await runGit(
      ["merge-base", "--is-ancestor", upstreamSha, forkHead],
      { cwd: repoRoot, allowExitCodes: [1] },
    );
    const containsUpstream = containsResult.exitCode === 0;

    report = {
      remote,
      branch,
      upstreamSha,
      forkHead,
      ahead,
      behind,
      containsUpstream,
      nextAction: nextAction({ ahead, behind, containsUpstream }),
    };
  } catch (error) {
    primaryError = error;
  }

  try {
    await runGit(["update-ref", "-d", tempRef], { cwd: repoRoot });
  } catch (error) {
    cleanupError = error;
  }

  if (primaryError) throw primaryError;
  if (cleanupError) {
    throw new CheckUpstreamError(
      "Could not remove the temporary upstream ref",
      {
        cause: cleanupError,
      },
    );
  }
  return report;
}

function parseArgs(args) {
  const options = {
    remote: DEFAULT_REMOTE,
    branch: DEFAULT_BRANCH,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-h" || argument === "--help") {
      return { help: true };
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--remote" || argument === "--branch") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CheckUpstreamError(`${argument} requires a value`);
      }
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--remote=") || argument.startsWith("--branch=")) {
      const separator = argument.indexOf("=");
      const key = argument.slice(2, separator);
      const value = argument.slice(separator + 1);
      if (!value) throw new CheckUpstreamError(`${key} requires a value`);
      options[key] = value;
      continue;
    }
    throw new CheckUpstreamError(`Unknown option: ${argument}`);
  }

  return options;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const report = await checkUpstream(options);
  process.stdout.write(
    `${options.json ? JSON.stringify(report, null, 2) : formatReport(report)}\n`,
  );
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  main().catch((error) => {
    console.error(`check-upstream failed: ${error.message}`);
    process.exitCode = 1;
  });
}
