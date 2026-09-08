#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const manifest = JSON.parse(
  await readFile(path.join(repoRoot, "package.json"), "utf8"),
);
const bin =
  typeof manifest.bin === "string"
    ? { [manifest.name]: manifest.bin }
    : manifest.bin;
const [cliName, cliTarget] = Object.entries(bin ?? {})[0] ?? [];
if (
  typeof manifest.name !== "string" ||
  typeof manifest.version !== "string" ||
  typeof cliName !== "string" ||
  typeof cliTarget !== "string"
) {
  throw new Error("package.json must define name, version, and bin");
}

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--tarball")) {
  throw new Error(
    "Usage: node scripts/test-package-install.mjs [--tarball /path/package.tgz]",
  );
}
const suppliedTarball = args.length ? path.resolve(args[1]) : null;

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const timeouts = { pack: 120_000, install: 120_000, cli: 15_000 };
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "roughdraft-package-install-"),
);
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
const artifactRoot = path.join(repoRoot, ".context", "package-repro", runId);
const packDirectory = path.join(artifactRoot, "pack");
const reportPath = path.join(artifactRoot, "report.json");

function commandText(command, args) {
  return [command, ...args]
    .map((part) => (part.includes(" ") ? JSON.stringify(part) : part))
    .join(" ");
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, options.timeoutMs ?? timeouts.cli);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) =>
      finish({
        command,
        args,
        exitCode: null,
        signal: null,
        timedOut,
        stdout,
        stderr: `${stderr}${error.stack ?? error.message}\n`,
      }),
    );
    child.on("close", (exitCode, signal) =>
      finish({ command, args, exitCode, signal, timedOut, stdout, stderr }),
    );
  });
}

async function record(label, result) {
  result.logLabel = label;
  await writeFile(
    path.join(artifactRoot, `${label}.stdout.log`),
    result.stdout,
  );
  await writeFile(
    path.join(artifactRoot, `${label}.stderr.log`),
    result.stderr,
  );
}

function summary(result) {
  return {
    command: commandText(result.command, result.args),
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdoutLog: `${result.logLabel}.stdout.log`,
    stderrLog: `${result.logLabel}.stderr.log`,
  };
}

function compact(output) {
  const maxChars = 2_400;
  if (output.length <= maxChars) return output;
  const edge = Math.floor(maxChars / 2);
  return `${output.slice(0, edge)}\n... output truncated; see receipt logs ...\n${output.slice(-edge)}`;
}

function printFailure(label, result) {
  console.error(
    `${label}: exit=${result.exitCode ?? `signal:${result.signal ?? "unknown"}`}${result.timedOut ? " timed-out" : ""}`,
  );
  console.error(`  $ ${commandText(result.command, result.args)}`);
  const output = `${result.stdout}${result.stderr}`.trim();
  if (output) console.error(compact(output));
}

function packageDirectory(consumerDirectory) {
  return path.join(
    consumerDirectory,
    "node_modules",
    ...manifest.name.split("/"),
  );
}

async function verifyInstalledServer(manager, invoke, installedDirectory) {
  const result = {
    command: "installed-server",
    args: [manager],
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
  };
  let managed = false;
  const receipt = {};
  try {
    const started = await invoke("start", ["start", "--json"]);
    assert.equal(started.exitCode, 0, `server start: ${started.stderr}`);
    receipt.start = JSON.parse(started.stdout);
    managed = receipt.start.managed && !receipt.start.reused;
    assert.equal(managed, true, "must start an isolated installed server");
    const get = async (route) => {
      const response = await fetch(new URL(route, receipt.start.url), {
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, 200, route);
      return response;
    };
    receipt.status = await (await get("/api/status")).json();
    assert.equal(receipt.status.pid, receipt.start.pid);
    assert.equal(
      await realpath(receipt.status.serverRoot),
      await realpath(installedDirectory),
    );
    const html = await (await get("/")).text();
    const asset = html.match(/<script[^>]+src="([^"]+)"/);
    assert.ok(asset, "packed homepage must reference a built script");
    const script = await (await get(asset[1])).text();
    assert.ok(script.length > 1000, "packed browser script must be present");
    receipt.asset = { path: asset[1], bytes: script.length };
  } catch (error) {
    result.exitCode = 1;
    result.stderr = String(error.stack ?? error);
  } finally {
    if (managed) {
      const stopped = await invoke("stop", ["stop", "--json"]);
      receipt.stop = stopped;
      try {
        assert.equal(stopped.exitCode, 0);
        assert.equal(JSON.parse(stopped.stdout).stopped, true);
        const status = await invoke("after-stop", ["status", "--json"]);
        assert.equal(JSON.parse(status.stdout).running, false);
      } catch (error) {
        result.exitCode = 1;
        result.stderr += `\nServer cleanup failed: ${error}`;
      }
    }
  }
  result.stdout = JSON.stringify(receipt, null, 2);
  await record(`${manager}-server`, result);
  return result;
}

async function runInstalledCli(manager, consumerDirectory, environment) {
  const installedDirectory = packageDirectory(consumerDirectory);
  const cliPath = path.resolve(installedDirectory, cliTarget);
  const packageRoot = path.resolve(installedDirectory);
  if (
    cliPath !== packageRoot &&
    !cliPath.startsWith(`${packageRoot}${path.sep}`)
  ) {
    throw new Error(
      `package.json bin points outside the package: ${cliTarget}`,
    );
  }

  const samplePath = path.join(consumerDirectory, "package-install-sample.md");
  await writeFile(
    samplePath,
    "# Package installation sample\n\nThe installed CLI must validate this file.\n",
  );
  let available = true;
  try {
    await access(cliPath);
  } catch {
    available = false;
  }

  const invoke = async (label, args) => {
    const result = available
      ? await runCommand(process.execPath, [cliPath, ...args], {
          cwd: consumerDirectory,
          env: environment,
          timeoutMs: timeouts.cli,
        })
      : {
          command: process.execPath,
          args: [cliPath, ...args],
          exitCode: null,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: `Installed ${cliName} bin is unavailable at ${cliPath}; no fallback command was attempted.\n`,
        };
    await record(`${manager}-${label}`, result);
    return result;
  };

  return {
    cliPath,
    samplePath,
    help: await invoke("doctor-help", ["doctor", "--help"]),
    version: await invoke("version", ["--version"]),
    doctor: await invoke("doctor", ["doctor", samplePath, "--json"]),
    server: await verifyInstalledServer(manager, invoke, installedDirectory),
  };
}

async function install(manager, tarballPath) {
  const consumerDirectory = path.join(temporaryRoot, `${manager}-consumer`);
  await mkdir(consumerDirectory, { recursive: true });
  await writeFile(
    path.join(consumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: `package-install-repro-${manager}-${process.pid}`,
        private: true,
        version: "0.0.0",
      },
      null,
      2,
    )}\n`,
  );

  let command;
  let args;
  let environment;
  if (manager === "npm") {
    const cache = path.join(temporaryRoot, "npm-cache");
    const userConfig = path.join(temporaryRoot, "npmrc");
    await mkdir(cache, { recursive: true });
    await writeFile(userConfig, "\n");
    command = npmCommand;
    args = [
      "--prefix",
      consumerDirectory,
      "--cache",
      cache,
      "--userconfig",
      userConfig,
      "install",
      tarballPath,
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
    ];
    environment = {
      ...process.env,
      NPM_CONFIG_CACHE: cache,
      NPM_CONFIG_USERCONFIG: userConfig,
      NPM_CONFIG_GLOBAL: "false",
      NO_COLOR: "1",
    };
  } else {
    const store = path.join(temporaryRoot, "pnpm-store");
    const pnpmHome = path.join(temporaryRoot, "pnpm-home");
    await mkdir(store, { recursive: true });
    await mkdir(pnpmHome, { recursive: true });
    command = pnpmCommand;
    args = ["--store-dir", store, "add", tarballPath, "--ignore-scripts"];
    // The clean consumer has no devDependencies, so this installs runtime deps only.
    environment = { ...process.env, PNPM_HOME: pnpmHome, NO_COLOR: "1" };
  }

  const installResult = await runCommand(command, args, {
    cwd: consumerDirectory,
    env: environment,
    timeoutMs: timeouts.install,
  });
  await record(`${manager}-install`, installResult);
  const cli = await runInstalledCli(manager, consumerDirectory, {
    ...environment,
    ROUGHDRAFT_NO_OPEN: "1",
    ROUGHDRAFT_STATE_DIR: path.join(consumerDirectory, ".roughdraft-state"),
    ROUGHDRAFT_PORT: manager === "npm" ? "49731" : "49732",
  });
  return { manager, consumerDirectory, install: installResult, ...cli };
}

function checks(result) {
  let doctorPayload;
  try {
    doctorPayload = JSON.parse(result.doctor.stdout);
  } catch {
    doctorPayload = null;
  }
  return [
    ["install", result.install, result.install.exitCode === 0],
    ["server and browser assets", result.server, result.server.exitCode === 0],
    [
      "doctor --help",
      result.help,
      result.help.exitCode === 0 &&
        result.help.stdout.includes(`${cliName} doctor [path] [--json]`),
    ],
    [
      "--version",
      result.version,
      result.version.exitCode === 0 &&
        result.version.stdout.trim() === manifest.version,
    ],
    [
      "doctor",
      result.doctor,
      result.doctor.exitCode === 0 &&
        doctorPayload?.kind === "markdown" &&
        doctorPayload.ok === true &&
        doctorPayload.path === result.samplePath,
    ],
  ];
}

try {
  await mkdir(packDirectory, { recursive: true });
  let tarballPath = suppliedTarball;
  if (!tarballPath) {
    const packCache = path.join(temporaryRoot, "pack-npm-cache");
    const packUserConfig = path.join(temporaryRoot, "pack-npmrc");
    await mkdir(packCache, { recursive: true });
    await writeFile(packUserConfig, "\n");
    const pack = await runCommand(
      npmCommand,
      ["pack", "--json", "--pack-destination", packDirectory],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          NPM_CONFIG_CACHE: packCache,
          NPM_CONFIG_USERCONFIG: packUserConfig,
          NO_COLOR: "1",
        },
        timeoutMs: timeouts.pack,
      },
    );
    await record("npm-pack", pack);
    if (pack.exitCode !== 0) {
      printFailure("npm pack", pack);
      throw new Error(`npm pack failed with exit code ${pack.exitCode}`);
    }

    const packed = JSON.parse(pack.stdout)[0];
    tarballPath = path.join(packDirectory, packed.filename);
  } else {
    await access(tarballPath);
  }
  const results = [];
  for (const manager of ["npm", "pnpm"]) {
    results.push(await install(manager, tarballPath));
  }

  const report = {
    package: {
      name: manifest.name,
      version: manifest.version,
      cliName,
      cliTarget,
      tarball: tarballPath,
    },
    packageManagers: results.map((result) => ({
      manager: result.manager,
      consumerDirectory: result.consumerDirectory,
      cliPath: result.cliPath,
      samplePath: result.samplePath,
      install: summary(result.install),
      help: summary(result.help),
      version: summary(result.version),
      doctor: summary(result.doctor),
      server: summary(result.server),
    })),
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const failures = [];
  for (const result of results) {
    for (const [label, commandResult, passed] of checks(result)) {
      if (passed) continue;
      failures.push(`${result.manager}: ${label} failed`);
      printFailure(`${result.manager} ${label}`, commandResult);
    }
  }
  if (failures.length > 0) {
    console.error(
      `Package installation regression failed for ${manifest.name}@${manifest.version}.`,
    );
    console.error(failures.map((failure) => `- ${failure}`).join("\n"));
    console.error(`Full receipt: ${reportPath}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Package installation passed for ${manifest.name}@${manifest.version} via npm and pnpm.`,
    );
    console.log(`Receipt: ${reportPath}`);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
