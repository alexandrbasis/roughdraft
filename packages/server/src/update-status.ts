import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  releaseArchive,
  type ReleasePackageManifest,
} from "../release-info.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultPackageJsonPath = path.resolve(__dirname, "../../../package.json");
const DEFAULT_PACKAGE_NAME = "roughdraft";

type PackageManifest = ReleasePackageManifest;

interface ParsedVersion {
  parts: number[];
  prerelease: string[];
}

export interface UpdateStatus {
  packageName: string;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  updateCommand: string;
}

interface ResolveUpdateStatusOptions {
  fetchImpl?: typeof fetch;
  packageJsonPath?: string;
  packageName?: string;
}

export function readInstalledManifest(
  packageJsonPath = defaultPackageJsonPath,
): PackageManifest {
  try {
    return JSON.parse(
      fs.readFileSync(packageJsonPath, "utf8"),
    ) as PackageManifest;
  } catch {
    return { name: DEFAULT_PACKAGE_NAME };
  }
}

function readInstalledPackageInfo(manifest: PackageManifest): {
  packageName: string;
  currentVersion: string | null;
} {
  return {
    packageName: manifest.name?.trim() || DEFAULT_PACKAGE_NAME,
    currentVersion: manifest.version?.trim() || null,
  };
}

function parseVersion(version: string): ParsedVersion {
  const normalizedVersion = version.trim().replace(/^v/i, "");
  const [mainVersion, prereleaseVersion = ""] = normalizedVersion.split("-", 2);
  const parts = mainVersion
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isNaN(part) ? 0 : part));

  const prerelease = prereleaseVersion
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);

  return { parts, prerelease };
}

function comparePrerelease(left: string[], right: string[]) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];

    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumber = Number.parseInt(leftPart, 10);
    const rightNumber = Number.parseInt(rightPart, 10);
    const leftIsNumeric = /^[0-9]+$/.test(leftPart);
    const rightIsNumeric = /^[0-9]+$/.test(rightPart);

    if (leftIsNumeric && rightIsNumeric) {
      if (leftNumber !== rightNumber) {
        return leftNumber < rightNumber ? -1 : 1;
      }
      continue;
    }

    if (leftIsNumeric !== rightIsNumeric) {
      return leftIsNumeric ? -1 : 1;
    }

    return leftPart.localeCompare(rightPart);
  }

  return 0;
}

export function compareVersions(leftVersion: string, rightVersion: string) {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  const length = Math.max(left.parts.length, right.parts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = left.parts[index] ?? 0;
    const rightPart = right.parts[index] ?? 0;

    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }

  return comparePrerelease(left.prerelease, right.prerelease);
}

async function fetchLatestVersion(
  packageName: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(1500),
      },
    );

    if (!response.ok) return null;

    const payload = (await response.json()) as PackageManifest;
    return payload.version?.trim() || null;
  } catch {
    return null;
  }
}

export async function resolveUpdateStatus(
  options: ResolveUpdateStatusOptions = {},
): Promise<UpdateStatus> {
  const manifest = readInstalledManifest(options.packageJsonPath);
  const installedPackageInfo = readInstalledPackageInfo(manifest);
  const packageName =
    options.packageName?.trim() || installedPackageInfo.packageName;
  const currentVersion = installedPackageInfo.currentVersion;
  const fetchImpl = options.fetchImpl ?? fetch;
  const archive = releaseArchive({ ...manifest, name: packageName });
  const latestArchive = archive
    ? await fetchLatestRelease({ ...manifest, name: packageName }, fetchImpl)
    : null;
  const latestVersion = archive
    ? (latestArchive?.version ?? null)
    : await fetchLatestVersion(packageName, fetchImpl);

  return {
    packageName,
    currentVersion,
    latestVersion,
    updateAvailable:
      !!currentVersion &&
      !!latestVersion &&
      compareVersions(currentVersion, latestVersion) < 0,
    updateCommand: archive
      ? `npm install -g ${(latestArchive ?? archive).url}`
      : `npm i -g ${packageName}@latest`,
  };
}

interface GitHubRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name?: string; state?: string; browser_download_url?: string }[];
}

async function fetchLatestRelease(
  manifest: PackageManifest,
  fetchImpl: typeof fetch,
) {
  const installed = releaseArchive(manifest);
  if (!installed) return null;
  try {
    // /latest excludes prereleases; the fork uses an explicit prerelease channel.
    const response = await fetchImpl(
      `https://api.github.com/repos/${installed.repository}/releases?per_page=100`,
      {
        headers: { accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(1500),
      },
    );
    if (!response.ok) return null;
    const releases: unknown = await response.json();
    if (!Array.isArray(releases)) return null;
    const channel = parseVersion(installed.version).prerelease[0];
    const candidates = (releases as GitHubRelease[]).flatMap((release) => {
      if (!release || release.draft || typeof release.tag_name !== "string")
        return [];
      const candidate = releaseArchive(
        manifest,
        release.tag_name.replace(/^v/, ""),
      );
      if (!candidate || candidate.tag !== release.tag_name) return [];
      const candidateChannel = parseVersion(candidate.version).prerelease[0];
      if (
        (release.prerelease || candidateChannel) &&
        (!channel || candidateChannel !== channel)
      )
        return [];
      if (
        !Array.isArray(release.assets) ||
        !release.assets.some(
          (asset) =>
            asset?.name === candidate.name &&
            asset.state === "uploaded" &&
            asset.browser_download_url === candidate.url,
        )
      )
        return [];
      return [candidate];
    });
    return (
      candidates.sort((left, right) =>
        compareVersions(right.version, left.version),
      )[0] ?? null
    );
  } catch {
    return null;
  }
}
