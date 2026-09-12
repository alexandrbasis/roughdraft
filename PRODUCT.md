# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The confirmed workflow is a person reviewing local Markdown documents and exchanging comments and replies with an agent.

## Product Purpose

Roughdraft lets the reviewer edit a document, leave anchored feedback, and hand the review back to an agent. Feedback remains readable in the Markdown file through CriticMarkup and YAML metadata.

## Operating Context

The app runs locally and opens documents through a worktree-specific CLI. Reviews include comments, replies, screenshot attachments, and suggestions. Mermaid previews and code highlighting help read technical documents. Narrow-window comment entry keeps the selected passage visible, including in embedded panels.

## Capabilities and Constraints

- Preserve the existing editor workflow and visual identity.
- Store local attachments as files and references in Markdown.
- Preserve comments and replies across save and reload.
- Reuse existing shadcn components and storage backends.
- Keep Mermaid source editable and preserve literal approximation text.
- Apply the selected appearance to diagrams and syntax highlighting without saving presentation changes into the document.
- Remote-session attachment support is an open capability outside this local-review task.

## Evidence on Hand

The implementation is in packages/app/src and packages/server/src. FORK.md links the upstream reports used to select improvements. docs/adr/0002-criticmarkup-as-review-format.md defines the portable review format.

## Product Principles

- Keep the document and feedback readable outside Roughdraft.
- Make saving, upload progress, and errors visible.
- Improve the current review workflow without replacing the editor.
