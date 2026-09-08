# Basis fork

This fork starts from [Lex-Inc/roughdraft](https://github.com/Lex-Inc/roughdraft)
commit `686919e`. The original MIT license and author attribution remain intact.
The fork package is `@alexandrbasis/roughdraft`, distributed as a built GitHub
release archive. It is not the unscoped `roughdraft` package on npm.

## Motivation and sources

| Change | Upstream reports and proposals |
| --- | --- |
| Reliable long review waits | [Issue 127](https://github.com/Lex-Inc/roughdraft/issues/127), [PR 121](https://github.com/Lex-Inc/roughdraft/pull/121), [PR 149](https://github.com/Lex-Inc/roughdraft/pull/149) |
| Preserve annotated code and task lists | [Issue 125](https://github.com/Lex-Inc/roughdraft/issues/125), [Issue 104](https://github.com/Lex-Inc/roughdraft/issues/104), [PR 143](https://github.com/Lex-Inc/roughdraft/pull/143) |
| Restore YAML-only replies to the review rail | [PR 145](https://github.com/Lex-Inc/roughdraft/pull/145) |
| Install the packed CLI with runtime dependencies | [Issue 137](https://github.com/Lex-Inc/roughdraft/issues/137), [Issue 116](https://github.com/Lex-Inc/roughdraft/issues/116) |
| Compact layout for host panels | [Issue 140](https://github.com/Lex-Inc/roughdraft/issues/140) |

These reports guided the changes. Each patch is checked against this checkout;
an upstream proposal is not treated as proof that a bug is fixed.

## Durable local reviews

Version 0.1.14 adds SQLite storage for routes, review rounds, completion events,
consumer acknowledgements, snapshots, and recoverable drafts. Existing JSON
stores migrate together and remain on disk as backups. Markdown remains in its
project; server writes use atomic replacement with a recoverable write journal.

The home list exposes round history and snapshot preview/restore. Restoring uses
a version check and requires another explicit confirmation after a conflict.
Browser drafts retain an offline copy and can recover a server-confirmed copy
from a separate browser. CLI and MCP report receipt separately from processing.

## Packaging

The server build bundles the private `@roughdraft/rfm` module with
[esbuild](https://esbuild.github.io/api/#bundle). `express` and `yaml` remain
external and are declared as root runtime dependencies. Shared chunks stay
beside the server entrypoints so paths derived from `import.meta.url` continue to
resolve the CLI child process, package metadata, and app assets.

The workspace uses pnpm's
[`allowBuilds` setting](https://github.com/pnpm/pnpm.io/blob/main/versioned_docs/version-10.x/settings.md#allowbuilds),
available since pnpm 10.26. The esbuild install script is enabled; the optional
msw install script is disabled.

## Keeping the fork current

Run `pnpm upstream:check` from this checkout. It fetches upstream's current main
commit and compares it with this checkout without merging or changing files.
Review upstream changes on a separate branch, then run the checks below before
opening a pull request in this fork. Never reset fork main to upstream main:
that would discard fork changes.

The installed fork checks this repository's GitHub releases for updates. It only
recommends a published release with the expected uploaded package archive.
Prerelease installations follow their channel (for example `basis`); stable
installations do not receive prereleases. Offline or rate-limited checks leave
the editor usable. The notice prints an explicit installation command; it does
not replace the running CLI automatically.

The updater uses the GitHub [list releases API](https://docs.github.com/en/rest/releases/releases#list-releases),
because GitHub's latest-release endpoint excludes prereleases.

## Releasing

Set the root `package.json` version and update the README install example. The
CLI and browser setup prompts derive their version and archive URL from the
manifest. Keep the lockfile unchanged unless dependencies change.

```bash
pnpm check
pnpm test:smoke
pnpm test:review
pnpm test:durable
pnpm test:coverage
pnpm release:prepare
pnpm test:package --tarball /absolute/path/printed/by/release-prepare.tgz
```

`release:prepare` writes the archive, `SHA256SUMS.txt`, and a manifest containing
the commit and package identity under `.context/release/`. Local receipts flag
uncommitted changes. Release automation rejects a dirty checkout or a tag that
does not match the package version.

After the pull request is checked and merged into this fork, tag the merged
commit as `v<package-version>` and push that tag. The **Release fork** workflow
runs repository, browser, and coverage checks; tests the same archive through
isolated npm and pnpm installations; and publishes it with its checksum and
commit manifest. A failed verification cannot reach the publish job. Existing
releases are not overwritten on a retry.

Tags ending in the Basis channel (such as `v0.1.14-basis.2`) trigger this workflow.
The original npm publication workflow runs only in `Lex-Inc/roughdraft`.

Download both the archive and `SHA256SUMS.txt` from the release into one directory,
then verify before installing:

```bash
shasum -a 256 -c SHA256SUMS.txt
npm install -g ./alexandrbasis-roughdraft-0.1.14-basis.2.tgz
roughdraft --version
```

The verification suite exercises two rounds of CLI/MCP review, interrupted
connections, annotated Markdown, YAML replies, keyboard operation, and embedded
panels. The first fork release also passed a real CLI wait longer than five
minutes; bounded timeout tests cover that behavior in routine CI.

Markdown checks cover metadata, lists and quotes, tables, raw HTML, code, Unicode,
and annotations. They assert content preservation and supported editing behavior;
rich-text round trips can normalize body formatting and line endings. Fence
boundaries follow the parser and the [CommonMark rules](https://spec.commonmark.org/0.31.2/#fenced-code-blocks).
