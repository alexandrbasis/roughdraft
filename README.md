# Roughdraft, Basis fork

A local Markdown editor for reviewing documents with coding agents. This fork of
[Lex-Inc/roughdraft](https://github.com/Lex-Inc/roughdraft) keeps the original MIT
license and stores comments and suggestions in the Markdown file.

## Install this fork

Use Node.js 22 or newer. Install the built package from this fork's GitHub release:

```bash
npm install -g https://github.com/alexandrbasis/roughdraft/releases/download/v0.1.11-basis.1/alexandrbasis-roughdraft-0.1.11-basis.1.tgz
roughdraft --version
roughdraft open /absolute/path/to/file.md
```

The version should be `0.1.11-basis.1`. The package is named
`@alexandrbasis/roughdraft`; the executable remains `roughdraft`. Installing it
globally shares the executable name with the original package.
The unscoped npm package `roughdraft` installs the original upstream version.

If the original package is installed globally, remove it with
`npm uninstall -g roughdraft` before installing this fork under the same command.

To try this checkout alongside your installed CLI, follow [Local development](#local-development)
and use its separate `roughdraft-dev-<worktree>` command.

## Changes in this fork

See [fork provenance and verification](FORK.md) for the upstream reports and release checks.

- Long CLI and MCP reviews wait across bounded requests, with an event cursor that
  preserves completion events between requests. An explicit timeout still limits
  the whole wait.
- Comments and suggestions inside fenced code preserve whitespace. Task-list
  serialization keeps checkbox syntax readable.
- Replies stored in YAML endmatter appear in their comment threads after reload.
- The built package includes the private Markdown module and declares its runtime
  dependencies, so it can be installed outside this monorepo.
- Add `&embed=1` to a document URL for a compact panel layout. The same editor,
  comments, save status, and review handoff remain available. Try `/preview?embed=1`
  without opening a file.

## What is this?
Roughdraft is a local-first markdown editor and viewer that runs on your computer.

Its job is to make markdown files easy to open, read, edit, review, and discuss with your AI agent without moving them into a proprietary format or a hosted app.

Roughdraft opens a single markdown file directly for CriticMarkup comments and suggested changes.
## How it works
- **Local-first markdown editor** — Open normal `.md` files from your machine and edit them directly
  
- **Works with your AI agent** — Tell your local agent to open a file in Roughdraft on your computer, then keep collaborating from there
  
- **Comments & suggested changes** — Use CriticMarkup for inline feedback, revisions, and review conversations
  
- **Markdown files on disk** — Everything stays as regular markdown files you can also edit in VS Code, Vim, Cursor, or anywhere else
  
- **No cloud, no account, no telemetry** — Runs entirely on your machine
  
## Quick start
After installing this fork, start the local server:

```bash
roughdraft start
```

`roughdraft start` runs Roughdraft in the background, reuses or chooses a free localhost port, writes server state to `~/.roughdraft/server.json`, prints the active URL, and exits while the server keeps running.

Open a specific markdown file:

```bash
roughdraft open ./path/to/my-essay/draft.md
```

For scripts and agents that need a URL without launching a browser:

```bash
roughdraft open ./path/to/my-essay/draft.md --print-url
roughdraft status --json
```

Check or stop the background server:

```bash
roughdraft status
roughdraft stop
```

`roughdraft open` will reuse the running server and auto-start it if needed. You can also use `roughdraft ./path/to/file.md` as a shortcut when the input clearly looks like a path.

Roughdraft does not edit `~/CLAUDE.md`, `~/AGENTS.md`, or other user-level agent files. The setup prompt asks your agent to update its own guidance.

If the local server is already running, you can also open a file directly by URL:

```text
http://localhost:7373/?path=/absolute/path/to/my-essay/draft.md
```

That makes an agent-friendly workflow possible:

1. Your AI writes or updates markdown files on disk.
  
2. You tell it to open a markdown file in Roughdraft.
  
3. Roughdraft opens locally on your machine.
  
4. You read, edit, leave comments, and suggest changes.
  
5. You click **Done Reviewing** in Roughdraft, and the AI can respond to your comments or revise the document.
  

Agents can watch that handoff directly:

```bash
roughdraft open ./path/to/my-essay/draft.md --json
```

`roughdraft open` starts or reuses the local server, opens the document, registers a fresh watcher, blocks until the next `review.completed` event, then prints event JSON with the document path, file version, feedback counts, and any optional `overallComment` you submit at handoff. By default there is no watch timeout; pass `--timeout <seconds>` when you want one. Use `--no-watch` when you only want to open the document and return immediately. If no watcher is active when you click **Done Reviewing**, Roughdraft shows a fallback prompt you can copy into the agent. Overall comments are written to Markdown as document-level YAML endmatter comments before the handoff event is emitted, so Markdown remains the durable source of truth.

Experimental MCP clients can start the stdio server with:

```bash
roughdraft mcp
```

The MCP server exposes tools to read the review index, list pending feedback, watch review events, append replies, and mark items resolved. CriticMarkup in the Markdown file remains the durable source of truth.
## Local development
```bash
./scripts/setup.sh
./scripts/run.sh
```

`./scripts/setup.sh` installs workspace dependencies and builds the app and server. `./scripts/run.sh` serves the built app at `http://localhost:7373`.

The two scripts coordinate through a lock file, so it's safe to start `./scripts/run.sh` while `./scripts/setup.sh` is still in progress. `run` will wait for setup to finish, or trigger setup itself if nothing has been built yet.

If you prefer package scripts, the same commands are available as `pnpm setup` and `pnpm start`.

Running `pnpm setup` also installs a per-worktree dev CLI wrapper into `~/.local/bin` by default, using the current worktree directory name. For example, this checkout might install `roughdraft-dev-lyon-v2`, which points at this worktree's local code while leaving the published global `roughdraft` command untouched.

Each dev wrapper keeps its own server state under `~/.roughdraft/dev/<wrapper-name>` by default, so opening a file from one worktree will not accidentally reuse a backend started from another worktree. `roughdraft-dev-<worktree> open ...` can start its own background server as needed; you do not need to run `pnpm dev` first just to open files in Roughdraft.

You can refresh that wrapper manually with:

```bash
pnpm dev:install-cli
pnpm dev:install-cli --name api-redesign
```

Quality checks:

```bash
pnpm lint
pnpm test
pnpm check
```

`pnpm check` is the same command the pull request workflow runs before merge.
## Publishing
Roughdraft publishes from `main` when the root `package.json` version is newer than the current npm `latest` version.

Release checks for this fork:

```bash
pnpm check
pnpm test:smoke
pnpm test:package
```

`test:package` packs the built checkout, installs the archive in clean temporary
projects with npm and pnpm, and runs the installed CLI. Publish the resulting
archive as a GitHub release asset. The inherited npm publishing workflow is
restricted to `Lex-Inc/roughdraft` and does not publish from this fork.
## Files on disk
```
my-essay/
  draft-1.md            # A normal markdown file on disk
  draft-2.md            # Another file you can open separately
```

Roughdraft reads and writes the markdown file directly.
## Agent setup

After installing this fork, ask your coding agent to read the local help:

```text
Read `roughdraft help agent` and `roughdraft help criticmarkup`, then use Roughdraft for Markdown reviews.
```

In Codex, run `roughdraft open /absolute/path/to/file.md --no-open`, open the printed
URL in the in-app browser, and keep the command attached until you finish reviewing.
Append `&embed=1` to that URL for compact mode.

## CLI reference
```text
roughdraft [flags] <command> [args]
roughdraft <path>
```

Commands:

```text
open <path>        Open one Markdown file and wait for Done Reviewing
start              Start or reuse the background server
status             Show server status
stop               Stop the managed background server
watch <path>       Wait for a Done Reviewing event
mcp                Start the experimental stdio MCP server
doctor [path]      Diagnose setup or validate Markdown
help agent         Print the agent setup prompt
help criticmarkup  Show CriticMarkup examples
agent-setup        Print the agent setup prompt
criticmarkup       Show CriticMarkup examples
```

Global flags:

```text
-h, --help         Show help
--version          Print version
--json             Print JSON for supported commands
--no-color         Disable color
```

Useful command flags:

```text
roughdraft open <path> --no-open
roughdraft open <path> --print-url
roughdraft open <path> --json
roughdraft open <path> --no-watch
roughdraft start --port <port>
roughdraft status --json
roughdraft stop --all
roughdraft watch ./draft.md --json
roughdraft doctor --json
roughdraft doctor ./draft.md
roughdraft doctor ./draft.md --json
```

Usage errors return exit code `2`. Runtime failures return exit code `1`. `roughdraft status --json` returns exit code `0` even when the JSON says `"running": false`.

Supported environment variables:

```text
ROUGHDRAFT_PORT
  Preferred server port.

PORT
  Legacy preferred server port. Used only when ROUGHDRAFT_PORT is unset.

ROUGHDRAFT_NO_OPEN=1
  Disable browser/app opening.

ROUGHDRAFT_STATE_FILE
  Exact path to the server state JSON file.

ROUGHDRAFT_STATE_DIR
  Directory containing server.json.
```

Development-only environment variables:

```text
ROUGHDRAFT_DEV_FRONTEND_STATE_FILE
ROUGHDRAFT_DEV_BIN_DIR
ROUGHDRAFT_DEV_STATE_BASE_DIR
ROUGHDRAFT_DEV_WRAPPER_NAME
ROUGHDRAFT_DEV_WRAPPER_PATH
ROUGHDRAFT_DEV_WRAPPER_REPO_ROOT
```
## Roughdraft-flavored CriticMarkup
Roughdraft uses [CriticMarkup](https://criticmarkup.com) as the readable review layer inside normal Markdown files. It supports the standard markers for comments, highlights, insertions, deletions, and substitutions:

The canonical Roughdraft Flavored Markdown spec is published at [roughdraft.md/spec/roughdraft-flavored-markdown.md](https://roughdraft.md/spec/roughdraft-flavored-markdown.md). The review-index JSON Schema is published at [roughdraft.md/spec/roughdraft-flavored-markdown.schema.json](https://roughdraft.md/spec/roughdraft-flavored-markdown.schema.json).

```markdown
This is {--deleted--} text.
This is {++inserted++} text.
This is {~~old~>new~~} substituted text.
This is {>>a comment<<} in the margin.
This is {==highlighted==} text.
```

Roughdraft extends those markers with compact id references so review state can round-trip through the file. Root comments and suggestions keep an inline anchor such as `{#c1}` or `{#s1}`, while metadata lives in final YAML endmatter:

```markdown
Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user" at="2026-06-14T06:38:34.897Z"}{>><<}{id="c6" by="user" at="2026-06-14T06:48:16.819Z" re="c1"}. --- comments: c1: by: user at: "2026-04-28T12:00:00.000Z"
```

Supported attributes:

- `id` is the compact inline reference after the comment or suggested change.
  
- `by` records the reviewer or agent that created it.
  
- `at` records an ISO timestamp.
  
- `re` links a reply to another comment or suggestion id.
  

Replies are stored in endmatter with a `body` and `re` pointer:

```markdown
Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user" at="2026-06-14T06:38:34.897Z"}{>><<}{id="c6" by="user" at="2026-06-14T06:48:16.819Z" re="c1"}. --- comments: c1: by: user at: "2026-04-28T12:00:00.000Z" c2: body: I can add one from the intro. by: AI at: "2026-04-28T12:05:00.000Z" re: c1
```

Suggested changes can also carry ids and discussion:

```markdown
Add {++one concrete example++}{#s1}.
Remove {--vague phrasing--}{#s2}.
Use {~~rough~>specific~~}{#s3} wording.

---
suggestions:
  s1:
    by: AI
    at: "2026-04-28T12:10:00.000Z"
  s2:
    by: user
    at: "2026-04-28T12:13:00.000Z"
  s3:
    by: AI
    at: "2026-04-28T12:14:00.000Z"
```

Older inline metadata such as `{id="c1" by="user" at="..."}` and legacy `{@id:c1; by:user; at:...@}` blocks are still accepted for compatibility.

CriticMarkup inside inline code and fenced code blocks is treated as literal example text, not live review feedback:

````markdown
Inline code stays literal: `{==not a comment==}`.

```text
{++not a suggestion++}
```
````

This matters because the main workflow is often:

- The AI writes a doc
  
- The user opens it in Roughdraft
  
- The user leaves comments and suggested changes
  
- The AI reads those comments and responds in the same markdown file
  
## Try the demo
Don't want to install anything? Try the [live demo](https://roughdraft.md) — it runs entirely in your browser using local storage.
## License
MIT

* * *

Built by [Nathan Baschez](https://twitter.com/nbashaw)
