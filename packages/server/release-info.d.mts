export interface ReleasePackageManifest {
  name?: string;
  version?: string;
  repository?: string | { type?: string; url?: string };
}
export function githubRepository(
  manifest: ReleasePackageManifest,
): string | null;
export function releaseArchive(
  manifest: ReleasePackageManifest,
  version?: string,
): {
  repository: string;
  version: string;
  tag: string;
  name: string;
  url: string;
} | null;
export function agentSetupPrompt(manifest: ReleasePackageManifest): string;
