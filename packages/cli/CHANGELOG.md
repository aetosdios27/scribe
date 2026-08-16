# @scribe-sdk/cli

## 0.1.0-beta.2

### Minor Changes

- 37f0b59: Render `scribe studio init` and every plan/apply command (`init`, `integrate`, `import`, `update`) inside labeled boxed panels — `ARTICLE DETAILS` around the studio-init prompts, `REVIEW & CONFIRM` around the plan summary and apply confirmation, and `RUN` around the live event stream and receipt — instead of an unbroken scroll of text. Falls back to today's plain rendering on narrow or non-interactive terminals.

### Patch Changes

- 37f0b59: Fix the native CLI crashing with a raw `EPIPE` stack trace when Ctrl+C was pressed during a running Studio session: the engine already shut Studio down gracefully on SIGINT, but the CLI had no signal handler of its own and died on the raw signal before the engine could finish, tearing the pipe out from under it. A second Ctrl+C still exits immediately. Also fixes long status values (like a lockfile-conflict message) breaking the label/value grid instead of wrapping with a hanging indent, and replaces the unstyled interactive prompts with ones matching the rest of the CLI's visual grammar.
  - @scribe-sdk/react@0.1.0-beta.2
  - @scribe-sdk/styles@0.1.0-beta.2
  - @scribe-sdk/mdx@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- 45ab086: Start Scribe Studio with the default loopback port when none is provided, so `scribe studio init` and `scribe studio <article>` launch without requiring `--port`; omit or null ports are treated as the default instead of an error.
  - @scribe-sdk/react@0.1.0-beta.1
  - @scribe-sdk/styles@0.1.0-beta.1
  - @scribe-sdk/mdx@0.1.0-beta.1

## 0.1.0-beta.0

### Patch Changes

- Updated dependencies [0597bf9]
  - @scribe-sdk/react@0.1.0-beta.0
  - @scribe-sdk/mdx@0.1.0-beta.0
  - @scribe-sdk/styles@0.1.0-beta.0

## 0.1.0-beta

### Minor Changes

- Complete the first beta authoring loop: create minimal articles with `scribe studio init`, update the aligned Scribe installation with `scribe update`, expose package and launcher version skew, introduce the inline `{S}` terminal identity, and remove the bogus Studio generated-MDX sourcemap warning.
  - @scribe-sdk/react@0.1.0-beta
  - @scribe-sdk/styles@0.1.0-beta
  - @scribe-sdk/mdx@0.1.0-beta

## 0.1.0-alpha.10

### Patch Changes

- f089df6: Harden CLI integration, rollback safety, package-manager detection, local delegation, and Studio startup behavior.
  - @scribe-sdk/react@0.1.0-alpha.10
  - @scribe-sdk/styles@0.1.0-alpha.10
  - @scribe-sdk/mdx@0.1.0-alpha.10

## 0.1.0-alpha.9

### Minor Changes

- 197ff98: Add a user-level `scribe` launcher that delegates to the project-local CLI inside a supported project and runs directly elsewhere, print the project's Scribe state from a bare `scribe` invocation, and make `scribe integrate` own package installation as a reviewed transaction that snapshots and restores the manifest, lockfile, and source files on failure and verifies the packages that should be present at the running CLI's version, the selected stylesheet, and the reported files. For pnpm and yarn the plan reports copyable install commands and stops with exit `2` before changing files until those packages are installed, and mismatched installed Scribe versions report the exact aligned `update` commands.

### Patch Changes

- @scribe-sdk/react@0.1.0-alpha.9
- @scribe-sdk/styles@0.1.0-alpha.9
- @scribe-sdk/mdx@0.1.0-alpha.9

## 0.1.0-alpha.8

### Patch Changes

- b5122f1: Import published stories from an official Medium export into validated local MDX with safe ZIP handling, response and draft filtering, image localization controls, dry-run planning, collision refusal, and rollback. Normalize Medium's decorative spacing and publication dates, format Banner dates for readers, restore ordinary list markers in the complete default editorial stylesheet after host resets, and prevent downstream CLI installs from resolving the known high-severity `js-yaml` advisory.
- Updated dependencies [b5122f1]
  - @scribe-sdk/mdx@0.1.0-alpha.8
  - @scribe-sdk/styles@0.1.0-alpha.8
  - @scribe-sdk/react@0.1.0-alpha.8

## 0.1.0-alpha.7

### Minor Changes

- Separate content setup from website integration: `scribe init` now creates only an empty content launchpad, while `scribe integrate` owns stack detection, package installation, MDX wiring, and stylesheet selection.

### Patch Changes

- Make Studio easier to enter and follow by advancing past occupied default ports, containing browser-launch and unexpected CLI failures, loading heavy commands only when invoked, and briefly emphasizing the preview block reached from sustained Markdown edits.
  - @scribe-sdk/react@0.1.0-alpha.7
  - @scribe-sdk/styles@0.1.0-alpha.7
  - @scribe-sdk/mdx@0.1.0-alpha.7

## 0.1.0-alpha.6

### Patch Changes

- 58f544e: Refine Scribe Studio with distinct Markdown and constrained Rich Text modes, a live read-only Markdown mirror, protected source-preserving MDX blocks, detected style mode, accessible controls, local IBM Plex typography, smooth preview scrolling, explicit-save safeguards, clearer diagnostics, and missing-asset feedback. Treat YAML frontmatter as article metadata, synthesize a Banner when appropriate, preserve the host's Tailwind Typography boundary in preview, and improve default table and mobile code-frame presentation.
- b8ac591: Promote `scribe` as the primary command while retaining `scb` as a silent prerelease compatibility alias. Add focused subcommand help, typo suggestions, project-relative diagnostics, structured initialization and validation output, and deterministic ANSI-free behavior for captured output and `NO_COLOR` environments.
- 8ca9ede: Protect Scribe Studio drafts with durable local recovery, serialized single-writer mutations, conflict-aware atomic saves, symlink-safe source handling, isolated compiler work, and live preview updates that do not reload the preview document.
- fb84ee5: Keep constrained Rich Text mode source-safe by avoiding serialization when users switch modes without editing, preserving protected MDX islands byte-for-byte, and naming the exact JSX, frontmatter, import, export, expression, comment, directive, or code metadata construct when an unsafe edit is rejected.
- c8d3dec: Prevent Scribe Studio from overwriting source changed by an external editor by revalidating the file immediately before save. Preserve unsaved drafts when the source is deleted or renamed, reload explicitly from current disk content, and retain the article's LF or CRLF line endings.
- 4d25b2f: Keep Scribe Studio's Rich Text table controls compact without stealing space from article content. One- to three-column tables now fit the editor pane, while wider tables scroll within it and preserve GFM column alignment.
- Updated dependencies [58f544e]
  - @scribe-sdk/styles@0.1.0-alpha.6
  - @scribe-sdk/mdx@0.1.0-alpha.6
  - @scribe-sdk/react@0.1.0-alpha.6

## 0.1.0-alpha.5

### Patch Changes

- Updated dependencies
  - @scribe-sdk/styles@0.1.0-alpha.5
  - @scribe-sdk/react@0.1.0-alpha.5
  - @scribe-sdk/mdx@0.1.0-alpha.5

## 0.1.0-alpha.4

### Patch Changes

- Restore strict React 19 typechecking for Vite MDX configurations and make Scribe Studio shut down cleanly when its CLI process receives `SIGINT` or `SIGTERM`.
- Updated dependencies
  - @scribe-sdk/mdx@0.1.0-alpha.4
  - @scribe-sdk/react@0.1.0-alpha.4
  - @scribe-sdk/styles@0.1.0-alpha.4

## 0.1.0-alpha.3

### Minor Changes

- Make Scribe's public alpha safe for established React sites: add foundation, default, and Tailwind style modes that preserve host-owned typography; add explicit, idempotent `scb init`; add a dedicated `next-mdx-remote/rsc` adapter; add the local source-authoritative Scribe Studio; and strengthen computed-style and visual-continuity verification.

- Existing `default.css` imports remain supported. Established sites should use `foundation.css`, Tailwind Typography sites should use `tailwind.css`, and `next-mdx-remote/rsc` integrations should use `createScribeRemoteMdxOptions()` from `@scribe-sdk/mdx/next-remote`.

### Patch Changes

- Updated dependencies
  - @scribe-sdk/react@0.1.0-alpha.3
  - @scribe-sdk/styles@0.1.0-alpha.3
  - @scribe-sdk/mdx@0.1.0-alpha.3

## 0.1.0-alpha.2

### Minor Changes

- Ship Scribe’s first public publishing SDK prerelease with publication rendering for content authored in Markdown, MDX, JSX, and semantic HTML; tested Next.js and Vite integration; host-adaptive editorial styles; responsive semantic tables; compile-time Shiki code rendering with code metadata and copy behavior; Banner, Callout, and Figure primitives; actionable validation and diagnostics; a packaged agent-native SKILL.md; and static and server-rendered article guarantees with hydration isolated to copying code.

### Patch Changes

- Updated dependencies
  - @scribe-sdk/mdx@0.1.0-alpha.2
