import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function runtimeStateDirectory(env: NodeJS.ProcessEnv = process.env) {
  if (env.ROUGHDRAFT_STATE_FILE?.trim()) {
    const stateFile = path.resolve(env.ROUGHDRAFT_STATE_FILE.trim());
    return path.basename(stateFile) === "server.json"
      ? path.dirname(stateFile)
      : `${stateFile}.data`;
  }
  return env.ROUGHDRAFT_STATE_DIR?.trim()
    ? path.resolve(env.ROUGHDRAFT_STATE_DIR.trim())
    : path.join(os.homedir(), ".roughdraft");
}

export function normalizePublicBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Use an HTTP or HTTPS origin, for example http://review.rd.",
    );
  }
  return url.origin;
}

function settingsPath(env: NodeJS.ProcessEnv) {
  return path.join(runtimeStateDirectory(env), "settings.json");
}

function readSettings(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const file = settingsPath(env);
  if (!fs.existsSync(file)) return {};
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Roughdraft settings: ${file}`);
  }
  return value as Record<string, unknown>;
}

export function readPublicBaseUrl(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.ROUGHDRAFT_PUBLIC_URL?.trim();
  if (configured) return normalizePublicBaseUrl(configured);
  const saved = readSettings(env).publicBaseUrl;
  if (saved === undefined) return null;
  if (typeof saved !== "string")
    throw new Error("Invalid publicBaseUrl setting.");
  return normalizePublicBaseUrl(saved);
}

export function savePublicBaseUrl(
  value: string | null,
  env: NodeJS.ProcessEnv = process.env,
) {
  const settings = readSettings(env);
  if (value === null) delete settings.publicBaseUrl;
  else settings.publicBaseUrl = normalizePublicBaseUrl(value);
  const file = settingsPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function prepareLocalDomain(
  hostname: string,
  port: number,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (
    hostname.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(
      hostname,
    ) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(
      "Use a hostname such as review.rd and a valid server port.",
    );
  }
  const name = hostname.toLowerCase();
  const publicBaseUrl = `http://${name}`;
  const directory = path.join(runtimeStateDirectory(env), "local-domain");
  const caddyfile = path.join(directory, `${name}.caddy`);
  const hostsFile = path.join(directory, `${name}.hosts`);
  const caddy = `${publicBaseUrl} {\n\tbind 127.0.0.1 [::1]\n\treverse_proxy 127.0.0.1:${port}\n}\n`;
  const hosts = `127.0.0.1 ${name}\n::1 ${name}\n`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(caddyfile, caddy, { mode: 0o600 });
  fs.writeFileSync(hostsFile, hosts, { mode: 0o600 });
  return {
    hostname: name,
    publicBaseUrl,
    port,
    caddyfile,
    hostsFile,
    caddy,
    hosts,
  };
}

export async function verifyPublicBaseUrl(
  value: string,
  expected: { serverRoot: string; port: number },
  fetchImpl: typeof fetch = fetch,
) {
  const publicBaseUrl = normalizePublicBaseUrl(value);
  const response = await fetchImpl(`${publicBaseUrl}/api/status`, {
    signal: AbortSignal.timeout(5_000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`Local address returned HTTP ${response.status}.`);
  const status = (await response.json()) as {
    serverRoot?: string;
    port?: number;
  };
  if (
    status.serverRoot !== expected.serverRoot ||
    status.port !== expected.port
  ) {
    throw new Error("That address does not reach this Roughdraft server.");
  }
  return publicBaseUrl;
}
