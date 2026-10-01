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
### Nested Lists Document
```markdown
# Nested lists

1. Parent
   1. Child
      1. Grandchild

9. First sibling
10. Mixed parent
    - Bulleted child
      1. Numbered grandchild
```
Edit a child in rich text, wait for Saved, and reload before capturing. Include desktop and narrow views. The child and grandchild must remain indented under their original parent, including the parent numbered `10.`.

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
## Document Width
Capture rich text and code modes at actual browser-pane widths of 2012px, 1440px, 1024px, 768px, 390px, and 320px, plus both sides of the 1440px comment-rail breakpoint. The page allocates a narrow tool column, a persistent outline and a flexible document pane. The sheet is at most 896px and centers in the space after the navigation columns. At 1440px and above, a 288px comment rail shares that pane; below it, active comments overlay the lower right of the document. The outline remains visible at every width, narrowing along with margins at the smallest sizes. Verify no horizontal page scrolling in either editor mode.

The icon-only document tools stay at the leading screen edge, followed by the outline. A separate vertical color legend below the tools shows one V-number per completed version, including V1. Capture the file menu, mode selector, version filter and history dialog at desktop and phone widths. Keep tools and outline clear of comment overlays. At short landscape heights or with many versions, the tool column scrolls; verify the last version and every tool remain keyboard and scroll reachable. Approve stays fixed at the upper right, above a reserved header row; scrolled document text must remain below it. Embedded panels retain the same navigation columns with their document background supplied by the host.

## Document Outline

Use a long document with H1–H6, repeated titles, a Setext heading, a formatted heading and a fenced Markdown example. The outline is always visible between the edge tools and the document, normally about 208px wide. There is no outline toggle or modal. All sections are expanded, hierarchy uses indentation, and full titles wrap inside the column.

Capture the persistent sidebar, active section after scrolling, long labels, a list taller than the screen and the empty outline in light and dark themes. Include 320px and 390px widths, a short landscape viewport, translated headings, 200% zoom and RTL text. Scrolling the outline must leave the document in place; selecting a heading keeps that outline position while revealing the destination. Each repeated title must navigate to its own heading in reading and source views. Renaming, adding or removing a heading updates the list before autosave; keyboard and pointer navigation preserve the document, current mode and Saved state. With a comment open, verify that the overlay stays in the document pane and outline entries remain clickable. Resize across the rail breakpoint with a selected heading and an unsaved comment reply, checking that section and draft remain accessible.

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
| Review home | Registered reviews | Start the app at `/` with `/api/reviews` returning registered records | `review-home`, `review-home-list`, `review-home-item` | Capture pending and reviewed rows, including watcher count and keyboard focus. Include long project names and routes at 390px; cards must fit without horizontal page scrolling. |
| Review home | Status filters and pages | Use a registry with more than 10 rows; select All, Waiting or Reviewed and change page | `review-filter-all`, `review-filter-pending`, `review-filter-completed`, `review-page-next`, `review-page-summary` | Capture counts, selected filter, page range and controls on desktop and at 375px. Reload preserves the URL selection. |
| Review home | Empty status | Select a status with zero rows | `review-filter-empty`, `review-filter-reset` | Show an empty result and a way to return to all reviews. |
| Review home | Round history | Expand History beside a registered review on a capable server | button named History, region named Review history | Show separate received/processed acknowledgements for each round; include a round with no acknowledgement. |
| Review home | Snapshot preview | Choose View snapshot from expanded history | dialog named Snapshot, button named Restore snapshot | Capture content, timestamp and explicit restore action. |
| Review home | Restore conflict | Preview a snapshot, edit the file externally, then restore | snapshot dialog, role=alert | Preserve the external edit; refresh current version before another explicit restore. |
| Document | Server draft available | Leave a server-confirmed unsaved draft, open the same file in a separate browser context | `draft-recovery-other` | Recovery is explicit and does not save to Markdown until confirmed. |
| Document | Own draft acknowledgement | Keep typing while an earlier server draft or save response is pending, then let it complete | `document-save-status` | Ordinary editing and the subsequent saved state must not display `draft-other-notice` for a copy created by this editor. Genuine drafts from a previous open remain recoverable. |
| Document | Server draft copy failed | Fail PUT `/api/reviews/drafts` while editing | `server-draft-error` | Local draft remains; server copy failure is separate from disk save status. |
| RFM guide | Default page | `/roughdraft-flavored-markdown` | `rfm-source-editor` | Capture the source editor plus rendered output. |
| RFM guide | Plan review example | Click `rfm-format-example-plan-review` | `rfm-format-example-plan-review` | Default example if already selected. |
| RFM guide | Spec review example | Click `rfm-format-example-spec-review` | `rfm-format-example-spec-review` | Confirms comments/suggestions render in the embedded demo. |
| RFM guide | Writing edit example | Click `rfm-format-example-writing-edit` | `rfm-format-example-writing-edit` | Useful for prose-focused review states. |
| Preview | Rich text default | `/preview?editor=rich-text` | `page-card-rich-text`, `rich-text-editor` | Uses in-memory preview backend and includes a sample anchored comment. |
| Preview | Code editor default | `/preview?editor=code` | `page-card-code`, `markdown-code-editor` | Capture line wrapping, code editor chrome, and rail behavior. |
| Document | Rich/code toggle | Use `document-editor-view-toggle` | `document-editor-view-toggle` | URL changes to `?editor=code` or `?editor=rich-text`. |
| Document | Floating tool help | Hover and keyboard-focus the left-side icons at desktop and 390px, including unavailable navigation and comparison controls | `document-floating-tools`, `document-file-menu-trigger`, `document-mode-trigger`, `revision-prev`, `revision-details` | Capture an explanatory tooltip beside the icon. Opening a file menu, mode list, filter, or dialog closes the tooltip. |
| Document | Persistent outline | Open a heading-rich document at desktop and in-app pane widths | `document-workspace-shell`, `document-outline-sidebar`, `document-outline-navigation`, `document-outline-entry` | Show edge tools, nested headings, the active section and the sheet centered in its remaining pane. |
| Document | Narrow outline and comments | Open a comment anchor at 390px or 320px | `document-outline-sidebar`, `document-comment-dock`, `document-comment-fallback` | Outline stays visible and clickable. Comment overlay is confined to the document pane; selection remains visible above it. |
| Document | Long outline | Open a document with many sections and long titles; scroll the outline and choose a later section | `document-outline-navigation`, `document-outline-entry`, `document-workspace` | Titles wrap completely. Outline scroll is independent and does not reset when a section is selected. |
| Document | Empty outline | Open a document with paragraphs but no headings | `document-outline-navigation` | Show the explanatory empty state; code-fenced heading examples must not appear as entries. |
| Document | Nested lists after save and reload | Open the nested lists fixture in rich text, edit a child, save, and reload | `rich-text-editor`, `document-save-status` | Capture three numbered levels and mixed bullet/numbered levels, including a multi-digit parent marker, at desktop and narrow widths. |
| Document revisions | Baseline | Register or open a document before its next saved edit; open the filter and History controls | `revision-toolbar`, `revision-filter-popover`, `revision-history-dialog` | The vertical toolbar stays icon-only. The first presented document is V1. History shows completed iterations and a separate Recovery points tab. Capture the initial empty state. |
| Document revisions | Multiple versions | Complete two iterations through Done or an agent open after editing, then open the file in reading view | `revision-highlight`, `revision-legend`, `revision-filter`, `revision-count` | Added text uses pastel version fills without V-number labels in the document. The separate floating list below the left menu shows one badge for each completed version in the matching color, including V1 and unchanged completed editions. Ordinary highlights have no underline; comment overlaps retain a version underline. Clicking current colored text places the caret and allows selecting and editing without opening comparison. Capture light and dark themes at desktop and 390px width. |
| Document revisions | Version legend growth | Complete at least five versions, hover or keyboard-focus a version badge, then use a short viewport and scroll the fixed column | `document-floating-rail`, `revision-legend`, `revision-legend-version-5` | Show one V-number per version. Tooltips give its author and completion time. The legend stays below the menu and outside the text while the document scrolls; the last badge remains reachable when the column overflows. |
| Document revisions | Filter and hidden highlights | Choose two version checkboxes, Latest change, no checkboxes, then All versions; toggle highlight visibility | `revision-filter-1`, `revision-filter-latest`, `revision-filter-all`, `revision-toggle`, `revision-prev`, `revision-next` | The filter popover shows the change count; multiple or no versions can be selected. Hiding highlights leaves document text and saved versions intact. Capture the vertical icon toolbar and popover at 390px width. |
| Document revisions | Overlapping comment | Change text already marked by a review comment | `revision-highlight`, `comment-thread-c1` | The comment remains the primary click target while the revision color stays visible. Capture the overlap in both themes and widths. |
| Document revisions | Inline deleted text | Delete words and a whole paragraph in separate saved revisions | `revision-deletion`, `revision-filter`, `revision-toggle` | The removed words appear in place, struck through and tinted with their revision color. No inline Deleted badges remain. Long deletions wrap and paragraph breaks remain visible. Filtering and hiding apply to deleted text, which never returns to saved Markdown. Capture light and dark themes at desktop and 390px width. |
| Document revisions | Deleted text comparison | Use Previous/Next to choose a deletion, then open Before / after | `revision-deletion`, `revision-details`, `revision-dialog`, `revision-before`, `revision-after` | The dialog opens only from the toolbar and shows removed text in Before and its absence in After. Inline deleted text is a passive, noneditable decoration. Capture the dialog in light and dark themes at desktop and 390px width. |
| Document revisions | History preview | Click the History icon and choose a saved version | `revision-history`, `revision-history-dialog`, `revision-history-preview`, `revision-structure-change` | Reading preview shows every change against the immediately preceding version in the selected version color, including additions, struck-through replaced/deleted text, and formatting or empty-block change labels. Later versions do not suppress earlier preview changes. The first version and recovery points remain plain. Preview is read-only and independent of highlight selection. Capture original and saved versions, reading and source views, on desktop and 390px. |
| Document revisions | Restore confirmation | Select a historical version and click Restore | `revision-history-restore`, `revision-restore-confirm`, `revision-restore-confirm-button` | Restore saves into the ongoing iteration and preserves history; the next V-number appears only after Done. Capture confirmation, pending save, blocked unsaved edits/conflict, and save error. A document change during confirmation requires a fresh confirmation. |
| Document | Formatted paragraph and list continuation | In Suggesting and Editing, press Enter inside bold/italic text and type; in Suggesting press Enter at the end of a list item, then Enter again in the empty new item | `rich-text-editor`, `document-mode-trigger` | Capture split paragraphs with retained inline formatting, the colored suggestion in the new paragraph, sibling numbered/bulleted/task items, and exit to a paragraph from an empty item. Press Backspace immediately after Enter and at the start of an existing paragraph or list item; capture the joined text with its formatting intact. Confirm saved formatting after reload; a heading ends in a normal paragraph. |
| Document | Soft line break | In Suggesting mode press Shift+Enter, then Backspace | `rich-text-editor`, `document-mode-trigger` | The break remains in the same paragraph. Backspace removes a newly suggested break. Capture before/after and check save/reload. |
| Document revisions | Formatting comparison | Change a paragraph into a heading or add bold formatting without changing its words | `revision-dialog`, `revision-before-format`, `revision-after-format` | The comparison names the changed formatting or structure even when the wording is identical. |
| Document revisions | Source mode | Switch a document with versions to code view and open the filter | `revision-toolbar`, `revision-details`, `revision-filter-popover` | History and comparison remain available. The filter explains that inline highlights are available in reading view. |
| Document revisions | Load or comparison error | Fail the revisions request, then open the filter or History and retry | `revision-error`, `revision-retry`, `revision-history-error` | Show the error in a popover or dialog without widening the icon toolbar; verify Retry restores highlights. A mocked response makes this state repeatable. |
| Document | Editing mode | Open mode menu and choose Editing | `document-mode-trigger` | Normal edit behavior. |
| Document | Suggesting mode | Open mode menu and choose Suggesting | `document-mode-trigger` | Selection actions should create suggestions instead of direct edits. |
| Document | Viewing mode | Open mode menu and choose Viewing | `document-mode-trigger` | Editing controls should look non-editable. |
| Document | Save status: saved | Any clean document after autosave | `document-save-status` | A persistent checkmark and visible `Saved` label sit at the upper left. Completed iterations are unchanged by autosave. |
| Document | Save status: unsaved | Type and capture near the start, halfway through and near the end of the ten-second interval | `document-save-status`, progressbar `Autosave countdown` | Show `Unsaved changes` and a circle filling clockwise toward the actual autosave deadline. Continuing to type must not restart the circle. After ten seconds, show `Saving` if the write is pending, then cross-fade to the checkmark only when it succeeds. A browser or server recovery copy does not mean the file has been saved. Manual save and Done flush immediately. Also capture reduced motion: progress remains readable, with no decorative cross-fade or spin. |
| Document | Save status: saving | Type and capture during autosave | `document-save-status` | Spinner and visible `Saving` label only while a write is pending. Transient; easiest with mocked delayed save. |
| Document | Save status: failed | Force save error | `document-save-status` | Visible `Save failed` label explains whether the recovery copy is only in this browser or confirmed on the server. Use backend/API mocking or a component harness. |
| Document | Remote save status | Save in a remote session | `document-save-status` | `Sent to remote session` explicitly says the source file has not acknowledged the write. |
| Document | Disk changed | Open local file, modify file externally while browser content is clean | `file-conflict-notice`, `file-conflict-action-reload`, `file-conflict-action-overwrite` | Banner title: `File changed on disk`. |
| Document | Save conflict | Edit in browser, then modify file externally before autosave resolves | `file-conflict-notice`, `file-conflict-action-keep-editing` | Banner title: `Save conflict`; autosave pauses. |
| Document | Autosave paused | Keep editing after conflict | `file-conflict-notice`, `file-conflict-action-overwrite` | Banner title: `Autosave paused`; no keep-editing action. |
| Document | Review handoff idle | Open a local file while a watcher is connected | `review-handoff-button` | Header text: `Agent watching`. |
| Document | Review handoff comment popover | Open a local file while a watcher is connected, then click the handoff dropdown trigger | `review-handoff-comment-trigger`, `review-handoff-comment-popover`, `review-handoff-overall-comment` | Capture the split handoff control and textarea with `Overall comment` placeholder before submission. |
| Global | Appearance | Switch System, Light, and Dark from the bottom-left appearance control | `theme-menu-trigger`, `theme-option-system`, `theme-option-light`, `theme-option-dark` | Capture dark inbox, rich-text editor, and code editor on desktop and narrow screens. System follows live OS changes; explicit choices survive reload. |
| Document | Review handoff sending | Click handoff button while watcher is connected, also with eight local review tabs open | `review-handoff-button` | Button label: `Sending`; text and review actions are temporarily locked. Source view keeps its latest text, selection and undo history when the lock clears. |
| Document | Review handoff sent | Successful handoff | `review-handoff-status`, `review-handoff-robots-toy`, `review-handoff-close-window`, `review-handoff-copy-message` | Capture the random completion title, robot toy, primary close button, and fallback copy hint below it. |
| Document | Review saved without an agent | Finish a local review with no watcher, or after its watcher disconnects | `review-handoff-button`, `review-handoff-status` | Button and popover title: `Not sent, but saved`. Show a normal saved state with a checkmark, no alert or automatic retry. Capture desktop and narrow layout. |
| Document | Completed review after reload | Finish a local review, then reload or reopen its URL without a new CLI handoff | `review-handoff-button`, `review-handoff-status` | The server restores `Review completed`. Clicking opens saved-status details without another completion event or version. A local edit or new CLI handoff reactivates the action. |
| Document | Next iteration | After Done, edit again or reopen the same URL from the CLI after an agent edit | `review-handoff-button`, `revision-history-dialog` | The finished handoff returns to Approve or I'm done. Existing text and comments remain; the next visible version appears only when that iteration is completed. |
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
| Comment dock | Narrow document composer | Select text midway through a long document below 1100px, then Add comment | `document-comment-dock`, `comment-banner-c1-editor` | Capture at 390px and 900px in both themes. A passage already clear of the dock stays in place; a covered passage moves only enough to become visible. Appearance and handoff controls remain usable. |
| Comment dock | Embedded composer | Select text in a long `?embed=1` document, then Add comment | `document-review-rail`, `comment-rail-c1-editor` | The existing flow rail becomes a dock while an anchor is active. Check source context, reply editing, attachments, and save controls without leaving the panel. |
| Review rail | Suggestions | Open review fixture in rich mode | `suggestion-thread-s1`, `suggestion-thread-s2`, `suggestion-thread-s3` | Thread containers use `data-suggestion-thread-container="true"`. |
| Review rail | Draft suggestion | Select text and choose a suggestion action | `draft-suggestion-thread`, `draft-suggestion-editor` | Capture dismiss/cancel/apply actions. |
| Comment editor | New root comment draft | Select text and choose Add comment | `comment-rail-c1-editor`, `comment-rail-c1-action-save` | Save uses the popover-style button; footer Cancel is absent because the thread trash action dismisses the draft. |
| Comment editor | Root comment editing | Use a comment card edit action | `comment-rail-root-editor` | Comment test IDs follow `comment-${variant}-${id}-...`. |
| Comment editor | Reply editing | Use a reply action | `comment-rail-child-editor` | Useful for nested thread spacing. |
| Code mode | Review rail present | Open review fixture with `?editor=code` | `page-card-code`, `markdown-code-editor` | Confirms code editor and rail can coexist. |
| Code mode | Review rail absent | Open fenced fixture with `?editor=code` | `page-card-code`, `markdown-code-editor` | Confirms fenced CriticMarkup alone does not create review rail. |
| Code block | Syntax highlighting | Open TypeScript and TSX fences in rich text | `code-block`, `.code-highlight` | Capture light and dark token colors. Unknown languages remain editable plain code. Highlighting must not save changes. |
| Mermaid | Diagram preview | Open a valid Mermaid fence in rich text | `mermaid-code-block`, `mermaid-rendered-svg`, `mermaid-view-diagram` | Capture both themes and a narrow panel. The SVG image is a preview; Markdown retains the original fence. |
| Mermaid | Editable source and review | Choose Source, add a comment or suggestion, save and reload | `mermaid-view-source`, `mermaid-source-panel`, `document-review-rail` | Activating the comment or suggestion reveals the source again. Include multiline code and source indentation. |
| Mermaid | Invalid source | Open an invalid Mermaid fence, then repair it | `mermaid-render-error`, `mermaid-source-panel` | Source stays editable with an error message. A repaired diagram can be shown again. |
| Mermaid | Loading | Delay diagram rendering | `mermaid-diagram-panel`, `role=status` | Loading stays inside the block. Rendering and view/theme switches must not modify Markdown. |
| Error/home fallback | Non-Markdown path | Open URL with `?path=/tmp/file.txt` | homepage error message | Copy: `Roughdraft now opens one .md file at a time.` |
| Error/home fallback | Missing/unloadable path | Open URL with invalid markdown path through local backend | homepage error message | Captures load-error homepage variant. |
| Review routes | Friendly route | Open a registered `/project/topic` route | `rich-text-editor`, `review-home-item` | The pathname remains readable on reload; browser title combines project and topic. |
| Draft recovery | Failed save and reload | Fail a save, reload the same tab | `draft-recovery-notice`, `draft-recovery-save` | Recovered content is visibly unsaved until explicitly saved. |
| Draft recovery | Disk conflict | Change the file externally before reloading a pending draft | `draft-recovery-recover-local`, `draft-recovery-overwrite` | Show the current file first; Preview my edits displays the browser copy. Use file from disk and Use my edits explain the choice. Both editions remain recoverable after reload; capture the Recovery points tab. |
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
