# Using Roughdraft

[Overview and setup prompt](../README.md) · [Fork provenance and releases](../FORK.md)

## Quick start
After installing the fork, start the local server:

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

Roughdraft does not edit `~/CLAUDE.md`, `~/AGENTS.md`, or other user-level agent files. The [setup prompt](../README.md#set-up-with-your-agent) asks your agent to update its own guidance.

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

`roughdraft open` starts or reuses the local server, opens the document, registers a fresh watcher, blocks until the next `review.completed` event, then prints event JSON with the document path, file version, feedback counts, and any optional `overallComment` you submit at handoff. By default there is no watch timeout; pass `--timeout <seconds>` when you want one. Use `--no-watch` when you only want to open the document and return immediately. You can finish a local review after its waiting agent session has ended. Comments stay in Markdown and completion stays in review history. With no active watcher, Roughdraft shows **Not sent, but saved** as a completed result. Resume the original agent session when convenient and have it read the document or history. Completion makes one automatic delivery attempt; an absent watcher does not trigger retries. A transport or save failure remains an error with an explicit manual retry. Overall comments are written to Markdown as document-level YAML endmatter comments before the handoff event is emitted, so Markdown remains the durable source of truth.

Experimental MCP clients can start the stdio server with:

```bash
roughdraft mcp
```

The MCP server exposes tools to read the review index, list pending feedback, watch review events, append replies, and mark items resolved. CriticMarkup in the Markdown file remains the durable source of truth.
## Parallel reviews and readable links

One detached server serves reviews from different folders. Concurrent CLI starts
share a startup lock. Registered documents keep stable routes and appear on the
homepage with pending/completed status and a live count of waiting agents.
Opening a completed file through the CLI begins another review round at the same address.
Parallel opens of a pending file join the current round. Viewing or reloading its link does not change its completion status.

The local server stores registrations, review rounds, completion events, agent
acknowledgements, snapshots, and server drafts in `~/.roughdraft/roughdraft.sqlite`.
The first start imports the older JSON registry and event journal in one
transaction. Their original files remain unchanged as migration backups and are
not read again once the import succeeds. Corrupt input stops migration with an
error; it is never silently replaced with an empty database.
CLI and MCP waits reconnect after transport failures; local
waiters restart a stopped server and retain their event cursor. An explicit
`--timeout` remains the total waiting deadline. Completion history is retained
until you remove the state directory. Saved feedback also stays in Markdown.

To use an address such as `http://review.rd/admitad-one/appsflyer`:

```bash
roughdraft domain setup review.rd
```

This prepares a hosts-file snippet and a Caddy snippet, then prints their paths.
Add the hosts entries to your operating system's hosts file, include the generated
Caddy snippet in your existing Caddy configuration, validate it, and reload Caddy.
The generated listener binds only to loopback. The OS may require administrator
permission for the hosts file. Caddy is an optional system dependency; Roughdraft
does not install it or replace an existing configuration. See the official
[Caddy reload commands](https://caddyserver.com/docs/command-line) and
[loopback binding documentation](https://caddyserver.com/docs/caddyfile/directives/bind).

```bash
roughdraft domain enable http://review.rd
roughdraft open ./draft.md --print-url
roughdraft domain status
```

`enable` checks that the address reaches this Roughdraft installation and port
before saving it. Each new open verifies it again. `domain disable` restores
localhost links. `ROUGHDRAFT_PUBLIC_URL` overrides the saved setting. Until an
address is enabled, old `?path=` links remain the default; registered routes also
work on the local server. Names come from the nearest project root and the first
Markdown heading; collisions receive a stable suffix.

Use `ROUGHDRAFT_STATE_DIR` to isolate another server. A custom
`ROUGHDRAFT_STATE_FILE` other than `server.json` puts its companion data in
`<state-file>.data/`. Servers with different state directories do not share
registrations, settings, or completion history.

Pending editor changes are saved in browser storage and synchronized to a
per-tab server draft before the 10-second automatic disk save. **Save** and
**Done Reviewing** flush the current editor content to disk immediately. After a
reload, the editor offers recovery; if the file changed on disk, both versions
are preserved for an explicit choice. Saving is serialized per document, and a
failed write or unavailable browser storage remains visibly unsaved. Browser
drafts belong to that browser profile and origin. New local servers also retain
a server copy, which another browser can explicitly recover. The editor shows
when that copy fails; changes made while disconnected depend on the local browser
copy until synchronization succeeds. Clearing browser storage removes that local
copy. Review events already lost by older versions cannot be reconstructed.
Permanent recovery points are kept when file content is written or a draft is
discarded; each routine server-draft update does not create one.

The review inbox shows ten records per page. Use All, Waiting, or Reviewed to
filter the list; each filter shows its total count. The selected filter and page
are kept in the URL and survive a reload. Changing a filter returns to page one;
if a refresh removes the last page, the inbox shows the nearest remaining page.

Local review tabs use short background requests for file changes and CLI open
requests, normally about once per second. They do not reserve HTTP/1 connections,
so several open tabs can still save and send reviews. Failed background requests
retry with a delay. Local save and completion requests time out after 15 seconds
and show the existing retry state instead of waiting indefinitely.

## Review history and recovery

Expand **History** beside a document in the review inbox to inspect rounds,
agent acknowledgements, and saved snapshots. Snapshot restore requires an explicit
selection and checks the current file version before replacing it. An external
edit after preview produces a conflict instead of being overwritten.

Agents can inspect history and confirm that they processed a completion event:

```bash
roughdraft read /absolute/path/to/draft.md
roughdraft read /absolute/path/to/draft.md --json
roughdraft submit /absolute/path/to/draft.md --from /absolute/path/to/edition.md --expected-version <version-from-read> --json
roughdraft submit /absolute/path/to/draft.md --from - --expected-version <version-from-read> --json
roughdraft history /absolute/path/to/draft.md --json
roughdraft ack 42 --consumer-id agent-example --json
```

`read` requires the running local server and does not open or complete a review. It
prints the current saved Markdown, including CriticMarkup comments and suggestions,
even while the user is still editing. It also shows whether editing is in progress
and how many completed versions exist. A legacy or direct-path version with unknown
completion shows its first-observed time and is excluded from that count. `--json`
includes the full saved content, parsed feedback index, version history with a
nullable completion time, and recovery drafts, checkpoints, and snapshots as
separate fields. A recovery draft may contain newer unsaved text; it is not the
saved document or a completed version. Remote document sessions do not yet provide
this read contract.

`submit` accepts complete Markdown from a file or stdin and conditionally saves it
through the local server. Use the `version` returned by `read --json` as its
required `--expected-version`. A successful submit records an Agent version and
hands the document back for review. Repeating the same successful request is
idempotent. If the file changed or human editing or a differing server draft is
active, submit reports a conflict; read the latest document and resolve the
conflict before trying again. It works with existing local Markdown files.

Use the event sequence and consumer ID returned by your watch result in place of
`42` and `agent-example`. Watching acknowledges receipt on capable servers;
`ack` marks processing only when the agent explicitly calls it after handling the
feedback. `--received` records receipt without claiming processing. These are
separate states; a successful HTTP response is not proof that an agent applied
requested edits.

Markdown remains the editable source in your project. Existing-file saves stage
and sync a replacement before renaming it into place. SQLite retains previous and
proposed content and a write intent: after a restart, an applied file can finish
its pending completion transaction; an unrelated external edit is preserved and
reported as a conflict. Filesystem writes and SQLite are not a single transaction.
Concurrent external writers still require version checks; snapshots provide a
recovery path rather than a promise of lossless simultaneous editing.

MCP reply/resolve and remote CLI saves also replace existing files atomically and
keep content-addressed backups in `~/.roughdraft/markdown-backups/` (or the
configured state directory). These direct/offline writes and edits by other
programs do not automatically create server history entries.

The database uses SQLite WAL with `synchronous=FULL`. It uses the built-in
[`node:sqlite`](https://nodejs.org/download/release/v22.13.1/docs/api/sqlite.html)
API (experimental in Node 22), avoiding an extra database service or native npm
install script. Keep the database on local disk. To back it up manually, stop
Roughdraft and copy the entire state directory; a running WAL database must be
backed up through SQLite's [backup API](https://sqlite.org/backup.html), not by
copying only the `.sqlite` file. See [WAL durability](https://sqlite.org/wal.html).
Snapshots and history currently have no automatic expiration. Original JSON
migration backups contain only the pre-migration state; downgrading does not
convert newer SQLite data back into those files.

HTTP custom names do not expose all secure-context browser APIs. Copy uses a
fallback where supported; use Ctrl+V or Cmd+V for paste. See the
[Clipboard API requirements](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API).

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

See [fork release checks and publication](../FORK.md#releasing). This fork
publishes tested GitHub release archives. The upstream npm workflow runs only
in `Lex-Inc/roughdraft`.

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
For compact mode, set the `embed=1` query parameter, using `?` for the first parameter or `&` after existing parameters. Open the CLI-returned URL once and reuse that browser tab.

Reuse the same CLI installation and state directory for subsequent reviews. If a
sandbox blocks the state lock or localhost check, retry the same command with the
required host access. `--state-dir` intentionally creates an isolated server with
its own domain settings and review history; it is not a permission workaround.
When a tracked process still exists but cannot be reached, `status --json` exits
with code 1 and reports `running: null`, `status: "unreachable"`. Its state is
preserved, and `start` or `open` will not launch a replacement until the existing
server can be verified or its process has stopped.
An active CLI or MCP watch keeps retrying its original server with the same event
cursor and timeout while the status check is temporarily unavailable.

## CLI reference
```text
roughdraft [flags] <command> [args]
roughdraft <path>
```

Commands:

```text
open <path>        Open one Markdown file and wait for Done Reviewing
start              Start or reuse the background server
domain             Configure a readable local review address
status             Show server status
stop               Stop the managed background server
watch <path>       Wait for a Done Reviewing event
history <path>     Show rounds, acknowledgements and snapshots
ack <sequence>     Explicitly mark feedback processed (--received for receipt)
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
ROUGHDRAFT_PUBLIC_URL
  Override the configured public review URL.

ROUGHDRAFT_HOST
  Use a hosted Roughdraft instance for remote document sessions.

ROUGHDRAFT_TOKEN
  Authenticate remote sessions.

ROUGHDRAFT_BIND_HOST
  Server bind hosts. Non-loopback hosts require ROUGHDRAFT_TOKEN.

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
Please revisit {==this sentence==}{>>Needs a source<<}{#c1}.

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
```

Supported attributes:

- `id` is the compact inline reference after the comment or suggested change.
  
- `by` records the reviewer or agent that created it.
  
- `at` records an ISO timestamp.
  
- `re` links a reply to another comment or suggestion id.
  

Replies are stored in endmatter with a `body` and `re` pointer:

```markdown
Please revisit {==this sentence==}{>>Needs a source<<}{#c1}.

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
  c2:
    body: I can add one from the introduction.
    by: AI
    at: "2026-04-28T12:05:00.000Z"
    re: c1
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
The [upstream browser demo](https://roughdraft.md) uses local storage and does not represent all fork features.
## License
MIT

* * *

Built by [Nathan Baschez](https://twitter.com/nbashaw)
