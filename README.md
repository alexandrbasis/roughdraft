# Roughdraft, Basis fork

A local Markdown editor for reviewing documents with AI agents. Edit the file,
leave comments and suggestions, then hand the review back to your agent.

## Set up with your agent

Copy this prompt into a coding agent with terminal, file, and browser access:

```text
Set up https://github.com/alexandrbasis/roughdraft on this computer for my
document reviews. Use this fork's current main and adapt commands to my OS.

1. Inspect existing Roughdraft installs, server state, and agent instructions.
   Preserve my files, settings, reviews, and unrelated instructions. Install
   missing Git, Node.js >=22.13, and pnpm >=10.26 using the OS's normal tools.
   Use a clean clone of fork main, or safely update an existing clean checkout.

2. In the checkout run pnpm install --frozen-lockfile, pnpm build, and
   pnpm release:prepare. Install the printed archive with npm install -g,
   targeting the existing Roughdraft prefix if present. If upstream owns the
   same command, replace that package deliberately. Verify the command path,
   package identity, and version resolve to this fork. Keep normal reviews on its default state;
   reserve worktree CLIs and isolated state for development.

3. Start or reuse the installed server. If an older server is running, preserve
   its state and active reviews before restarting it with the new package.
   Install Caddy if needed. Configure review.rd using roughdraft domain setup,
   its generated hosts/Caddy snippets, and domain enable. Merge with existing configuration and keep the
   service on loopback. Request OS permissions when needed. If a custom domain
   is unavailable, keep the verified localhost URL and explain what remains.

4. Read roughdraft help agent and roughdraft help criticmarkup. Locate the
   global instructions actually loaded by this agent, such as AGENTS.md or
   CLAUDE.md; update their source file, preserving symlinks and existing rules.
   Add this compact contract once:

   "Review written deliverables and implementation plans with me in Roughdraft
   before treating them as agreed or starting work that depends on approval.
   Save them as Markdown and run installed roughdraft open <absolute-path>
   --no-open, using its default state and configured URL. Open the CLI-returned
   URL once in the agent's browser and reuse that tab; otherwise show the link.
   Keep the command attached until I finish. Then reread the file, address its
   CriticMarkup feedback, and reopen when another review is needed. Read
   roughdraft help criticmarkup for syntax. On sandbox errors, retry the same
   command with required access. Use rd only as my shorthand for Roughdraft."

5. Verify the source commit, installed package, running server, and rendered
   page agree. Open a small test Markdown file for me, verify its URL, and keep
   the review attached. After I finish, reread it and confirm the handoff works.
   Report the checkout, commit, installed command, review URL, and global
   instructions file changed. Separate verified results from remaining gaps.
```

This installs current source, which can be ahead of a published release with
the same package version. Record the commit as well as the version. The agent
must adapt installation to the host; native Windows setup has not been verified.
The optional checkout setup scripts and dev wrappers require Bash.

## What you can do

| Capability | Behavior |
| --- | --- |
| Edit Markdown | Rich-text and source views, edit/suggest modes, autosave, tables, nested lists, task lists, code, and local file changes. Formatting may normalize on a rich-text save. |
| Review with agents | Anchored comments, replies, suggestions, resolution, overall handoff comments, and approval of unchanged documents. Feedback stays in Markdown as CriticMarkup and YAML. |
| Inspect revisions | Saved revision/source filters, change counts, previous/next navigation, before/after views, highlighted additions, and inline struck-through deletions. Revision display is separate from review suggestions. |
| Read and annotate | Mermaid previews with editable source, code highlighting, system/light/dark themes, keyboard navigation, and compact embedded layouts. |
| Attach screenshots | Paste or attach images in local comments and replies. Files live beside the document in `.roughdraft-assets`; keep that folder with the Markdown. |
| Run parallel reviews | One server for documents across projects, stable readable routes, an inbox with status filters, and counts of waiting agents. |
| Recover work | SQLite-backed rounds, snapshots, completion events and acknowledgements; browser/server drafts, conflict checks, and explicit snapshot restore. |
| Integrate tools | CLI waits and experimental MCP tools for feedback, replies, resolution, and handoff. Local waits reconnect with their event cursor; an unreachable live server is preserved instead of replaced. |
| Use another host | Remote document sessions send saves back through the connected CLI. Remote access requires configuration and authentication; image uploads are local-only. |

The [usage guide](docs/usage.md) covers commands, readable domains, storage,
recovery limits, MCP, and CriticMarkup. [Fork provenance](FORK.md) records the
upstream sources and release checks. [The format specification](docs/spec/roughdraft-flavored-markdown.md)
defines the Markdown contract.

## Install a published release

Use Node.js 22.13 or newer. For a tested release archive rather than current source:

```bash
npm install -g https://github.com/alexandrbasis/roughdraft/releases/download/v0.1.14-basis.6/alexandrbasis-roughdraft-0.1.14-basis.6.tgz
roughdraft --version
roughdraft open /absolute/path/to/draft.md
```

The package is `@alexandrbasis/roughdraft`; its command is `roughdraft`.
The unscoped npm package installs upstream. Both use the same command name, so
check the existing installation before replacing it. Published archives and
checksums are on [GitHub Releases](https://github.com/alexandrbasis/roughdraft/releases).
See [checksum verification](FORK.md#releasing).

## Daily use

```bash
roughdraft open /absolute/path/to/draft.md --no-open
roughdraft status --json
roughdraft history /absolute/path/to/draft.md --json
roughdraft help agent
roughdraft help criticmarkup
```

`open` starts or reuses the server and waits for the review handoff. Open its
printed URL once. After the user finishes, read the file again and process the
feedback. `--print-url` returns only the URL without waiting; use it for link
lookup, not the attached review workflow.

For readable links, run `roughdraft domain setup review.rd`, apply the generated
hosts and Caddy configuration, then run `roughdraft domain enable http://review.rd`.
See the [domain setup details](docs/usage.md#parallel-reviews-and-readable-links).
For embedded panels, add `embed=1` using `?` or `&` as appropriate for the URL.

Normal reviews share `~/.roughdraft`. Changing `--state-dir` creates a separate
server, domain configuration, and history. If a sandbox blocks localhost or the
state lock, retry with the necessary access while keeping the same command and
state. Markdown stays in its project; move `.roughdraft-assets` with it.

## Develop and release

For work on Roughdraft itself, use the checkout's isolated dev CLI:

```bash
pnpm setup
roughdraft-dev-<checkout-name> open /absolute/path/to/draft.md
pnpm check
pnpm test:smoke
```

Replace `<checkout-name>` with the wrapper name printed by setup. `pnpm setup`
uses Bash, installs dependencies, builds, and creates the wrapper. See
[local development](docs/usage.md#local-development) and [release procedure](FORK.md#releasing).
`pnpm upstream:check` compares this fork with upstream without merging it.

## License

MIT. Fork of [Lex-Inc/roughdraft](https://github.com/Lex-Inc/roughdraft), originally
built by [Nathan Baschez](https://twitter.com/nbashaw). The
[upstream browser demo](https://roughdraft.md) does not represent all fork features.
