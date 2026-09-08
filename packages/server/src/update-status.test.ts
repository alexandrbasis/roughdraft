import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareVersions, resolveUpdateStatus } from "./update-status";

describe("compareVersions", () => {
  it("orders numeric versions correctly", () => {
    expect(compareVersions("0.1.0", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("1.4.0", "1.4.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
  });

  it("treats prereleases as older than stable releases", () => {
    expect(compareVersions("0.2.0-beta.1", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("0.2.0-beta.2", "0.2.0-beta.1")).toBeGreaterThan(0);
  });
});

describe("resolveUpdateStatus", () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    tempPaths.forEach((tempPath) => {
      fs.rmSync(tempPath, { recursive: true, force: true });
    });
    tempPaths.length = 0;
  });

  it("reports when the installed version is behind npm", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-pkg-"));
    const packageJsonPath = path.join(tempDir, "package.json");
    tempPaths.push(tempDir);
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: "roughdraft", version: "0.1.0" }),
    );

    const status = await resolveUpdateStatus({
      packageJsonPath,
      fetchImpl: async () =>
        new Response(JSON.stringify({ version: "0.2.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    expect(status).toEqual({
      packageName: "roughdraft",
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      updateAvailable: true,
      updateCommand: "npm i -g roughdraft@latest",
    });
  });

  it("degrades cleanly when npm cannot be reached", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-pkg-"));
    const packageJsonPath = path.join(tempDir, "package.json");
    tempPaths.push(tempDir);
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: "roughdraft", version: "0.1.0" }),
    );

    const status = await resolveUpdateStatus({
      packageJsonPath,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });

    expect(status).toEqual({
      packageName: "roughdraft",
      currentVersion: "0.1.0",
      latestVersion: null,
      updateAvailable: false,
      updateCommand: "npm i -g roughdraft@latest",
    });
  });

  it("uses the newest complete non-draft GitHub archive for a fork prerelease", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-pkg-"));
    const packageJsonPath = path.join(tempDir, "package.json");
    const githubReleasesUrl =
      "https://api.github.com/repos/alexandrbasis/roughdraft/releases";
    const expectedArchiveUrl =
      "https://github.com/alexandrbasis/roughdraft/releases/download/v0.1.12-basis.1/alexandrbasis-roughdraft-0.1.12-basis.1.tgz";
    const requests: string[] = [];
    tempPaths.push(tempDir);
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({
        name: "@alexandrbasis/roughdraft",
        version: "0.1.11-basis.1",
        repository: {
          type: "git",
          url: "git+https://github.com/alexandrbasis/roughdraft.git",
        },
      }),
    );

    const status = await resolveUpdateStatus({
      packageJsonPath,
      fetchImpl: async (input) => {
        const url = String(input);
        requests.push(url);

        if (url.startsWith(githubReleasesUrl)) {
          return new Response(
            JSON.stringify([
              {
                tag_name: "v0.1.12-basis.0",
                draft: false,
                prerelease: true,
                assets: [
                  {
                    state: "uploaded",
                    name: "alexandrbasis-roughdraft-0.1.12-basis.0.tgz",
                    browser_download_url:
                      "https://github.com/alexandrbasis/roughdraft/releases/download/v0.1.12-basis.0/alexandrbasis-roughdraft-0.1.12-basis.0.tgz",
                  },
                ],
              },
              {
                tag_name: "v0.1.12-basis.1",
                draft: false,
                prerelease: true,
                assets: [
                  {
                    state: "uploaded",
                    name: "alexandrbasis-roughdraft-0.1.12-basis.1.tgz.sha256",
                    browser_download_url: `${expectedArchiveUrl}.sha256`,
                  },
                  {
                    state: "uploaded",
                    name: "alexandrbasis-roughdraft-0.1.12-basis.1.tgz",
                    browser_download_url: expectedArchiveUrl,
                  },
                ],
              },
              {
                tag_name: "v0.1.13-basis.1",
                draft: true,
                prerelease: true,
                assets: [
                  {
                    state: "uploaded",
                    name: "alexandrbasis-roughdraft-0.1.13-basis.1.tgz",
                    browser_download_url:
                      "https://github.com/alexandrbasis/roughdraft/releases/download/v0.1.13-basis.1/alexandrbasis-roughdraft-0.1.13-basis.1.tgz",
                  },
                ],
              },
              {
                tag_name: "v0.1.14-basis.1",
                draft: false,
                prerelease: true,
                assets: [
                  {
                    state: "uploaded",
                    name: "alexandrbasis-roughdraft-0.1.14-basis.1.tgz.sha256",
                    browser_download_url:
                      "https://github.com/alexandrbasis/roughdraft/releases/download/v0.1.14-basis.1/alexandrbasis-roughdraft-0.1.14-basis.1.tgz.sha256",
                  },
                ],
              },
            ]),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error(`Unexpected URL: ${url}`);
      },
    });

    expect(status).toEqual({
      packageName: "@alexandrbasis/roughdraft",
      currentVersion: "0.1.11-basis.1",
      latestVersion: "0.1.12-basis.1",
      updateAvailable: true,
      updateCommand: `npm install -g ${expectedArchiveUrl}`,
    });
    expect(requests.some((url) => url.startsWith(githubReleasesUrl))).toBe(
      true,
    );
  });
  it.each([
    ["offline", "0.1.11-basis.1", null],
    ["stable channel", "0.1.11", []],
    ["other prerelease channel", "0.1.11-beta.1", []],
    ["unuploaded asset", "0.1.11-basis.1", "new"],
    ["untrusted download", "0.1.11-basis.1", "external"],
  ])("does not recommend an unusable GitHub update: %s", async (_label, version, scenario) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-pkg-"));
    tempPaths.push(tempDir);
    const packageJsonPath = path.join(tempDir, "package.json");
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({
        name: "@alexandrbasis/roughdraft",
        version,
        repository: "https://github.com/alexandrbasis/roughdraft",
      }),
    );
    const status = await resolveUpdateStatus({
      packageJsonPath,
      fetchImpl: async () => {
        if (scenario === null) throw new Error("offline");
        return Response.json([
          {
            tag_name: "v0.1.12-basis.1",
            draft: false,
            prerelease: true,
            assets: [
              {
                name: "alexandrbasis-roughdraft-0.1.12-basis.1.tgz",
                state: scenario === "new" ? "new" : "uploaded",
                browser_download_url:
                  scenario === "external"
                    ? "https://example.com/untrusted.tgz"
                    : "https://github.com/alexandrbasis/roughdraft/releases/download/v0.1.12-basis.1/alexandrbasis-roughdraft-0.1.12-basis.1.tgz",
              },
            ],
          },
        ]);
      },
    });
    expect(status.latestVersion).toBeNull();
    expect(status.updateAvailable).toBe(false);
    expect(status.updateCommand).toContain(`/v${version}/`);
  });
});
