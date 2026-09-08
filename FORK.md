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

## Release verification

Run these checks before attaching a built archive to a release:

```bash
pnpm check
pnpm test:smoke
pnpm test:package
```

Also run the dedicated browser scenarios for annotated Markdown, endmatter
replies, and embed mode. A real CLI wait longer than five minutes exercises the
transport timeout boundary beyond the fast automated tests.
