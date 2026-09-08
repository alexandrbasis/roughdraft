// Shared by the CLI, browser setup prompt, and release tooling.
export function githubRepository(manifest) {
  const repository = manifest.repository;
  const url = typeof repository === "string" ? repository : repository?.url;
  return typeof url === "string"
    ? (/^git\+https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\.git$/.exec(url)?.[1] ??
        /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
          url,
        )?.[1] ??
        null)
    : null;
}

export function releaseArchive(manifest, version = manifest.version) {
  const repository = githubRepository(manifest);
  if (
    !repository ||
    !/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(manifest.name ?? "") ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      version ?? "",
    )
  ) {
    return null;
  }
  const name = `${manifest.name.slice(1).replace("/", "-")}-${version}.tgz`;
  const tag = `v${version}`;
  return {
    repository,
    version,
    tag,
    name,
    url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
  };
}

export function agentSetupPrompt(manifest) {
  const archive = releaseArchive(manifest);
  const install = archive
    ? `npm install -g ${archive.url}`
    : "npm install -g roughdraft";
  const product = archive ? "the Basis fork of Roughdraft" : "Roughdraft";
  return `Install ${product} using \`${install}\`, then read \`roughdraft help agent\` and set yourself up to use it.`;
}
