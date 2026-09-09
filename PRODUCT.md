# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The confirmed workflow is a person reviewing local Markdown documents and exchanging comments and replies with an agent.

## Product Purpose

Roughdraft lets the reviewer edit a document, leave anchored feedback, and hand the review back to an agent. Feedback remains readable in the Markdown file through CriticMarkup and YAML metadata.

## Operating Context

The app runs locally and opens documents through a worktree-specific CLI. The current task covers comments and replies with screenshots, including clipboard paste, in the existing light and dark themes.

## Capabilities and Constraints

- Preserve the existing editor workflow and visual identity.
- Store local attachments as files and references in Markdown.
- Preserve comments and replies across save and reload.
- Reuse existing shadcn components and storage backends.
- Remote-session attachment support is an open capability outside this local-review task.

## Evidence on Hand

The user confirmed this scope on 2026-09-09. The existing implementation is in packages/app/src and packages/server/src. docs/adr/0002-criticmarkup-as-review-format.md defines the portable review format.

## Product Principles

- Keep the document and feedback readable outside Roughdraft.
- Make saving, upload progress, and errors visible.
- Improve the current review workflow without replacing the editor.
