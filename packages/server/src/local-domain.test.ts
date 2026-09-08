import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizePublicBaseUrl,
  prepareLocalDomain,
  readPublicBaseUrl,
  runtimeStateDirectory,
  savePublicBaseUrl,
  verifyPublicBaseUrl,
} from "./local-domain";

const directories: string[] = [];
function environment() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "roughdraft-domain-"),
  );
  directories.push(directory);
  return {
    ROUGHDRAFT_STATE_FILE: path.join(directory, "custom", "daemon.json"),
  };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
describe("local review address", () => {
  it("prepares loopback-only routing without enabling an unverified address", () => {
    const env = environment();
    const setup = prepareLocalDomain("review.rd", 7373, env);
    expect(fs.readFileSync(setup.caddyfile, "utf8")).toContain(
      "bind 127.0.0.1 [::1]",
    );
    expect(setup.caddy).toContain("reverse_proxy 127.0.0.1:7373");
    expect(fs.readFileSync(setup.hostsFile, "utf8")).toBe(
      "127.0.0.1 review.rd\n::1 review.rd\n",
    );
    expect(readPublicBaseUrl(env)).toBeNull();
  });
  it("keeps the configured address with an isolated custom state file", () => {
    const env = environment();
    const settings = path.join(runtimeStateDirectory(env), "settings.json");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ otherSetting: 1 }));
    savePublicBaseUrl("http://review.rd/", env);
    expect(readPublicBaseUrl(env)).toBe("http://review.rd");
    expect(JSON.parse(fs.readFileSync(settings, "utf8")).otherSetting).toBe(1);
    savePublicBaseUrl(null, env);
    expect(readPublicBaseUrl(env)).toBeNull();
  });
  it("rejects injected configuration and URL credentials or routes", () => {
    for (const name of [
      "review.rd\nrespond hacked",
      "review.rd:80",
      "../review.rd",
      "review.rd/evil",
      "*.review.rd",
    ]) {
      expect(() => prepareLocalDomain(name, 7373, environment())).toThrow();
    }
    for (const url of [
      "file:///tmp",
      "http://user:password@review.rd",
      "http://review.rd/path",
      "http://review.rd?x=1",
    ]) {
      expect(() => normalizePublicBaseUrl(url)).toThrow();
    }
  });
  it("rejects another service or checkout before activation", async () => {
    const expected = { serverRoot: "/current", port: 7373 };
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ serverRoot: "/other", port: 7373 }),
      )) as typeof fetch;
    await expect(
      verifyPublicBaseUrl("http://review.rd", expected, fetchImpl),
    ).rejects.toThrow("does not reach");
    const correct = (async () =>
      new Response(JSON.stringify(expected))) as typeof fetch;
    await expect(
      verifyPublicBaseUrl("http://review.rd", expected, correct),
    ).resolves.toBe("http://review.rd");
  });
});
