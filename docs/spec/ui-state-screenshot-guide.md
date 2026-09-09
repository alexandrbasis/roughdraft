# Roughdraft UI State Screenshot Guide
This file is a reusable checklist for capturing Roughdraft's major UI states. It is meant to support periodic visual review, not to replace automated tests.
## Screenshot Folder Convention
Put each run in a timestamped directory:

```bash
mkdir -p .context/ui-state-screenshots/$(date +%Y%m%d-%H%M%S)
```

Use filenames that sort by product area, viewport, and state:

```text
01-home-desktop.png
01-home-mobile.png
02-home-install-dialog.png
03-home-workflow-stage-1.png
04-preview-rich-review-rail.png
```
## Starting The App
For route-only states, the Vite app is enough:

```bash
pnpm --filter @roughdraft/app dev -- --host 127.0.0.1 --port 5173
```

Useful URLs:

```text
http://127.0.0.1:5173/
http://127.0.0.1:5173/roughdraft-flavored-markdown
http://127.0.0.1:5173/preview
http://127.0.0.1:5173/preview?editor=code
http://127.0.0.1:5173/preview?editor=rich-text
http://127.0.0.1:5173/preview?embed=1
```

For an embedded workspace panel, append `&embed=1` to a document URL, or use
`/preview?embed=1`. Capture rich text and code modes at 380px and 720px, including
light and dark themes. The document fills the panel without outer paper borders
or shadows. Text keeps its internal padding, and the file menu, mode selector,
save status, and review handoff remain reachable. Also capture a desktop review
with the comment rail visible. Omitting `embed=1` keeps the normal page layout.

For local file backend states, use the worktree-specific CLI wrapper:

```bash
worktree_root="$(git rev-parse --show-toplevel)"
worktree_name="$(basename "$worktree_root")"
roughdraft_cmd="roughdraft-dev-$worktree_name"

command -v "$roughdraft_cmd" >/dev/null || pnpm dev:install-cli
"$roughdraft_cmd" start
"$roughdraft_cmd" open "$worktree_root/.context/ui-state-fixtures/review.md" --print-url --no-open --no-watch
```
## Fixture Documents
Create these under `.context/ui-state-fixtures/` when a capture run needs stable local-file states.
### Plain Document
```markdown
# Plain document
Paragraph with **bold**, [link](https://example.com), `inline code`.

- [ ] Task
- [x] Done

| Area | Status |
| --- | --- |
| Intro | Draft |
```
### Review Document
```markdown
# Review document {==Select this sentence==}{>>Root comment<<}{#root} This sentence includes {++clearer wording++}{#s1}. Replace {~~old phrase~>new phrase~~}{#s2} and remove {--dead text--}{#s3}.

---
comments:
  root:
    by: Nora
    at: "2026-04-28T12:00:00.000Z"
  child:
    body: Nested reply
    by: AI
    at: "2026-04-28T12:01:00.000Z"
    re: root
  c1:
    body: Looks good.
    by: Nora
    at: "2026-04-28T12:03:00.000Z"
    re: s1
suggestions:
  s1:
    by: AI
    at: "2026-04-28T12:02:00.000Z"
  s2:
    by: AI
    at: "2026-04-28T12:04:00.000Z"
  s3:
    by: AI
    at: "2026-04-28T12:05:00.000Z"
```
### Fenced CriticMarkup Document
```markdown
# Fenced examples This page should not show a review rail just because examples appear inside code fences. ```text {==example==}{>>comment<<}{#c1} {++inserted++} {--deleted--} {~~old~>new~~} ```
```
## Capture Matrix
| Area | State | How to reach it | Useful selectors | Notes |
| --- | --- | --- | --- | --- |
| App shell | Initial loading | Load any route and capture before backend initialization completes, usually with a route/mock delay | none | Transient; easiest in a mocked route or component harness. |
| Homepage | Desktop | `/` at desktop viewport | `homepage-workflow-storyboard` | Capture first viewport and a lower scroll position where the storyboard is active. |
| Homepage | Mobile | `/` at mobile viewport | `homepage-workflow-storyboard`, `homepage-workflow-scene-list` | Sticky visual is hidden until the workflow heading has scrolled past. |
| Homepage | Install dialog | Click the install CTA | Base UI dialog content | Include the terminal command and close affordance. |
| Homepage | Workflow stage 1 | Scroll storyboard to first scene | `homepage-workflow-terminal`, `homepage-workflow-scene` | User request visible; agent work and popup are hidden. |
| Homepage | Workflow stage 2 | Scroll to second scene | `homepage-workflow-agent-work` | Agent work becomes visible. |
| Homepage | Workflow stage 3 | Scroll to third scene | `homepage-workflow-terminal-command`, `homepage-workflow-popup` | Roughdraft command and document popup are visible. |
| Homepage | Workflow stage 4 | Scroll to fourth scene | `homepage-workflow-review-rail`, `homepage-workflow-comment-highlight` | User feedback appears in the document/review rail. |
| Homepage | Workflow stage 5 | Scroll to fifth scene | `homepage-workflow-handoff-button` | Done handoff button is visible. |
| Homepage | Workflow stage 6 | Scroll to final scene | `homepage-workflow-agent-resume` | Agent resume line and incorporated plan are visible; done button is hidden. |
| Homepage | Update notice | Start app with backend status returning `updateStatus` | update notice component | Best captured with API mocking unless an update is actually available. |
| Review home | Registered reviews | Start the app at `/` with `/api/reviews` returning registered records | `review-home`, `review-home-list`, `review-home-item` | Capture pending and reviewed rows, including watcher count and keyboard focus. |
| Review home | Status filters and pages | Use a registry with more than 10 rows; select All, Waiting or Reviewed and change page | `review-filter-all`, `review-filter-pending`, `review-filter-completed`, `review-page-next`, `review-page-summary` | Capture counts, selected filter, page range and controls on desktop and at 375px. Reload preserves the URL selection. |
| Review home | Empty status | Select a status with zero rows | `review-filter-empty`, `review-filter-reset` | Show an empty result and a way to return to all reviews. |
| Review home | Round history | Expand History beside a registered review on a capable server | button named History, region named Review history | Show separate received/processed acknowledgements for each round; include a round with no acknowledgement. |
| Review home | Snapshot preview | Choose View snapshot from expanded history | dialog named Snapshot, button named Restore snapshot | Capture content, timestamp and explicit restore action. |
| Review home | Restore conflict | Preview a snapshot, edit the file externally, then restore | snapshot dialog, role=alert | Preserve the external edit; refresh current version before another explicit restore. |
| Document | Server draft available | Leave a server-confirmed unsaved draft, open the same file in a separate browser context | `draft-recovery-other` | Recovery is explicit and does not save to Markdown until confirmed. |
| Document | Server draft copy failed | Fail PUT `/api/reviews/drafts` while editing | `server-draft-error` | Local draft remains; server copy failure is separate from disk save status. |
| RFM guide | Default page | `/roughdraft-flavored-markdown` | `rfm-source-editor` | Capture the source editor plus rendered output. |
| RFM guide | Plan review example | Click `rfm-format-example-plan-review` | `rfm-format-example-plan-review` | Default example if already selected. |
| RFM guide | Spec review example | Click `rfm-format-example-spec-review` | `rfm-format-example-spec-review` | Confirms comments/suggestions render in the embedded demo. |
| RFM guide | Writing edit example | Click `rfm-format-example-writing-edit` | `rfm-format-example-writing-edit` | Useful for prose-focused review states. |
| Preview | Rich text default | `/preview?editor=rich-text` | `page-card-rich-text`, `rich-text-editor` | Uses in-memory preview backend and includes a sample anchored comment. |
| Preview | Code editor default | `/preview?editor=code` | `page-card-code`, `markdown-code-editor` | Capture line wrapping, code editor chrome, and rail behavior. |
| Document | Rich/code toggle | Use `document-editor-view-toggle` | `document-editor-view-toggle` | URL changes to `?editor=code` or `?editor=rich-text`. |
| Document | Editing mode | Open mode menu and choose Editing | `document-mode-trigger` | Normal edit behavior. |
| Document | Suggesting mode | Open mode menu and choose Suggesting | `document-mode-trigger` | Selection actions should create suggestions instead of direct edits. |
| Document | Viewing mode | Open mode menu and choose Viewing | `document-mode-trigger` | Editing controls should look non-editable. |
| Document | Save status: saved | Any clean document after autosave | `document-save-status` | Checkmark should sit fixed in the top-left corner and fade out over 2 seconds; accessible label remains `Saved`. |
| Document | Save status: unsaved | Type in a local document before save completes | `document-save-status` | Spinner-only pending state; accessible label is `Unsaved changes`. Transient; often easier with save throttling or network mocking. |
| Document | Save status: saving | Type and capture during autosave | `document-save-status` | Spinner-only pending state; accessible label is `Saving`. Transient; easiest with mocked delayed save. |
| Document | Save status: failed | Force save error | `document-save-status` | Icon-only error state; accessible label is `Save failed`. Use backend/API mocking or a component harness. |
| Document | Disk changed | Open local file, modify file externally while browser content is clean | `file-conflict-notice`, `file-conflict-action-reload`, `file-conflict-action-overwrite` | Banner title: `File changed on disk`. |
| Document | Save conflict | Edit in browser, then modify file externally before autosave resolves | `file-conflict-notice`, `file-conflict-action-keep-editing` | Banner title: `Save conflict`; autosave pauses. |
| Document | Autosave paused | Keep editing after conflict | `file-conflict-notice`, `file-conflict-action-overwrite` | Banner title: `Autosave paused`; no keep-editing action. |
| Document | Review handoff idle | Open a local file while a watcher is connected | `review-handoff-button` | Header text: `Agent watching`. |
| Document | Review handoff comment popover | Open a local file while a watcher is connected, then click the handoff dropdown trigger | `review-handoff-comment-trigger`, `review-handoff-comment-popover`, `review-handoff-overall-comment` | Capture the split handoff control and textarea with `Overall comment` placeholder before submission. |
| Global | Appearance | Switch System, Light, and Dark from the bottom-left appearance control | `theme-menu-trigger`, `theme-option-system`, `theme-option-light`, `theme-option-dark` | Capture dark inbox, rich-text editor, and code editor on desktop and narrow screens. System follows live OS changes; explicit choices survive reload. |
| Document | Review handoff sending | Click handoff button while watcher is connected, also with eight local review tabs open | `review-handoff-button` | Button label: `Sending`. |
| Document | Review handoff sent | Successful handoff | `review-handoff-status`, `review-handoff-robots-toy`, `review-handoff-close-window`, `review-handoff-copy-message` | Capture the random completion title, robot toy, primary close button, and fallback copy hint below it. |
| Document | Review saved without an agent | Finish a local review with no watcher, or after its watcher disconnects | `review-handoff-button`, `review-handoff-status` | Button and popover title: `Not sent, but saved`. Show a normal saved state with a checkmark, no alert or automatic retry. Capture desktop and narrow layout. |
| Document | Review handoff error | Force handoff API error or hold a local save/completion request past its 15-second deadline | `review-handoff-status` | Popover title: `Could not notify agent`. |
| Remote | Connected banner | Open with `?session=<id>&token=<token>` and remote capability enabled | `role=status`, `aria-label="Remote session connected"` | Requires remote backend support in `/api/status`. |
| Remote | Disconnected banner | Drop remote session connection | `role=alert`, `aria-label="Remote session disconnected"` | Best captured with backend mocking. |
| Editor | Selection menu | Select text in rich editor | `selection-menu` | Capture formatting buttons and comment/suggestion actions. |
| Editor | Selection menu on suggestion | Select existing suggestion text | `selection-menu-action-accept-suggestion`, `selection-menu-action-reject-suggestion` | Requires review fixture. |
| Editor | Link popover | Click a link or choose Link from selection menu | `link-popover`, `link-url-input`, `link-action-open`, `link-action-delete` | Use the plain fixture link. |
| Editor | Context menu | Right-click in rich editor | `editor-context-menu` | Capture comment, suggestion, paste, and paste-markdown actions. |
| Review rail | Comments | Open review fixture in rich mode | `document-review-rail`, `comment-thread-root` | Thread containers use `data-comment-thread-container="true"`. |
| Review rail | Keyboard-expanded comment | Tab to a collapsed thread and press Enter or Space | `comment-thread-c1`, `comment-rail-c1-action-reply` | Capture the focused thread; Tab continues into its actions. |
| Comment editor | Reply cancelled | Activate Reply, then press Escape in the empty reply | `comment-rail-c1-action-reply` | Capture focus returned to Reply and the removed draft. |
| Comment editor | Screenshot composer | Edit a comment or reply; paste an image or choose Attach image | `comment-rail-c1-editor`, `comment-rail-c1-editor-attach`, `comment-image-remove` | Capture the text, attachment preview, remove action, and paste hint in both themes, desktop and narrow layouts. |
| Comment editor | Screenshot upload pending | Delay POST `/api/assets` after attaching an image | `comment-rail-c1-editor-upload-status` | Typing stays available; save and cancel wait for the upload. |
| Comment editor | Screenshot upload failed | Fail POST `/api/assets`, then retry the same file | `comment-rail-c1-editor-upload-error` | Error remains beside the composer; existing text is preserved. |
| Review rail | Saved screenshot | Save a comment and a reply with images, then reload | `comment-image` | Thumbnails open full images and wrap inside the rail. Include a missing-file preview fallback. |
| Document | Handoff screenshot | Open the handoff comment popover and attach an image | `review-handoff-overall-comment-attach`, `comment-image` | The shared composer shows the same upload and preview states. |
| Embedded document | Narrow screenshot composer | At 390px wide, attach an image and scroll to Save | `comment-rail-c1-action-save`, `theme-menu-trigger` | Save remains above the fixed Appearance control in both themes. |
| Review navigation | Embedded narrow document | Open a long review fixture with `?embed=1` | `document-review-comments-link`, `document-review-rail` | The keyboard-reachable jump link keeps comments discoverable when the flow rail is below the document. |
| Review rail | Suggestions | Open review fixture in rich mode | `suggestion-thread-s1`, `suggestion-thread-s2`, `suggestion-thread-s3` | Thread containers use `data-suggestion-thread-container="true"`. |
| Review rail | Draft suggestion | Select text and choose a suggestion action | `draft-suggestion-thread`, `draft-suggestion-editor` | Capture dismiss/cancel/apply actions. |
| Comment editor | New root comment draft | Select text and choose Add comment | `comment-rail-c1-editor`, `comment-rail-c1-action-save` | Save uses the popover-style button; footer Cancel is absent because the thread trash action dismisses the draft. |
| Comment editor | Root comment editing | Use a comment card edit action | `comment-rail-root-editor` | Comment test IDs follow `comment-${variant}-${id}-...`. |
| Comment editor | Reply editing | Use a reply action | `comment-rail-child-editor` | Useful for nested thread spacing. |
| Code mode | Review rail present | Open review fixture with `?editor=code` | `page-card-code`, `markdown-code-editor` | Confirms code editor and rail can coexist. |
| Code mode | Review rail absent | Open fenced fixture with `?editor=code` | `page-card-code`, `markdown-code-editor` | Confirms fenced CriticMarkup alone does not create review rail. |
| Error/home fallback | Non-Markdown path | Open URL with `?path=/tmp/file.txt` | homepage error message | Copy: `Roughdraft now opens one .md file at a time.` |
| Error/home fallback | Missing/unloadable path | Open URL with invalid markdown path through local backend | homepage error message | Captures load-error homepage variant. |
| Review routes | Friendly route | Open a registered `/project/topic` route | `rich-text-editor`, `review-home-item` | The pathname remains readable on reload; browser title combines project and topic. |
| Draft recovery | Failed save and reload | Fail a save, reload the same tab | `draft-recovery-notice`, `draft-recovery-save` | Recovered content is visibly unsaved until explicitly saved. |
| Draft recovery | Disk conflict | Change the file externally before reloading a pending draft | `draft-recovery-recover-local`, `draft-recovery-overwrite` | Show the current disk version first; recovery preserves both versions until the user chooses. |
| Draft recovery | Closed tab | Close a tab after a failed save, then reopen the file | `draft-other-notice`, `draft-recovery-other` | Offer recovery of browser drafts left in another tab without deleting newer drafts. |
| Clipboard | Local HTTP domain | Open the editor context menu on `http://review.rd` | `editor-context-menu-action-paste` | Clipboard copy uses its fallback; unavailable paste actions are disabled and explain keyboard paste. |
## Playwright Capture Skeleton
```ts
import { chromium, devices } from "playwright";

const baseUrl = process.env.ROUGHDRAFT_BASE_URL ?? "http://127.0.0.1:5173";
const outDir = process.env.ROUGHDRAFT_SCREENSHOT_DIR ?? ".context/ui-state-screenshots/manual";

const browser = await chromium.launch();
const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await desktop.goto(`${baseUrl}/`);
await desktop.screenshot({ path: `${outDir}/01-home-desktop.png`, fullPage: true });

const mobile = await browser.newPage({ ...devices["iPhone 13"] });
await mobile.goto(`${baseUrl}/`);
await mobile.screenshot({ path: `${outDir}/01-home-mobile.png`, fullPage: true });

await browser.close();
```

For interaction-heavy states, prefer selectors over coordinates. The current code has stable `data-testid` hooks for the homepage storyboard, editor view toggle, mode trigger, conflict banner/actions, review rail, rich editor, code editor, selection menu, link popover, and context menu.
## States That Need A Harness Or Mocking
These are real product states, but they are awkward to capture deterministically through only public routes:

- Initial loading
  
- Save status: saving, failed, and sometimes unsaved
  
- Disk conflict and autosave paused
  
- Review handoff undelivered/error
  
- Remote connected/disconnected banners
  
- Update notice
  

The most reliable long-term solution is a dedicated screenshot harness route or Playwright component harness that renders `DocumentWorkspace` with controlled backend, disk, remote, watcher, and save states. Keep the production-route screenshots for broad layout coverage and use the harness for rare operational states.
## Maintenance Checklist
- Add a row when a new route, dialog, popover, banner, editor mode, or empty/error state ships.
  
- Add or update a fixture when a new Markdown/Roughdraft Format feature changes rendering.
  
- Prefer `data-testid` selectors for screenshot automation; add a selector when a state matters visually.
  
- Capture desktop and mobile for page-level states.
  
- Capture both rich-text and code editor for document states that affect the editor surface or review rail.
  
- Keep screenshots in `.context/` unless the run is intentionally being committed as visual documentation.
