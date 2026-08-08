# @scribe-sdk/styles

## 0.1.0-alpha.10

## 0.1.0-alpha.9

## 0.1.0-alpha.8

### Patch Changes

- b5122f1: Import published stories from an official Medium export into validated local MDX with safe ZIP handling, response and draft filtering, image localization controls, dry-run planning, collision refusal, and rollback. Normalize Medium's decorative spacing and publication dates, format Banner dates for readers, restore ordinary list markers in the complete default editorial stylesheet after host resets, and prevent downstream CLI installs from resolving the known high-severity `js-yaml` advisory.

## 0.1.0-alpha.7

## 0.1.0-alpha.6

### Patch Changes

- 58f544e: Refine Scribe Studio with distinct Markdown and constrained Rich Text modes, a live read-only Markdown mirror, protected source-preserving MDX blocks, detected style mode, accessible controls, local IBM Plex typography, smooth preview scrolling, explicit-save safeguards, clearer diagnostics, and missing-asset feedback. Treat YAML frontmatter as article metadata, synthesize a Banner when appropriate, preserve the host's Tailwind Typography boundary in preview, and improve default table and mobile code-frame presentation.

## 0.1.0-alpha.5

### Patch Changes

- Keep compile-time Shiki foreground and background colors paired in Tailwind mode, including Tailwind's ancestor `.dark` convention and explicit publication-theme overrides, so prose code backgrounds cannot make highlighted code unreadable.

## 0.1.0-alpha.4

## 0.1.0-alpha.3

### Minor Changes

- Make Scribe's public alpha safe for established React sites: add foundation, default, and Tailwind style modes that preserve host-owned typography; add explicit, idempotent `scb init`; add a dedicated `next-mdx-remote/rsc` adapter; add the local source-authoritative Scribe Studio; and strengthen computed-style and visual-continuity verification.

- Existing `default.css` imports remain supported. Established sites should use `foundation.css`, Tailwind Typography sites should use `tailwind.css`, and `next-mdx-remote/rsc` integrations should use `createScribeRemoteMdxOptions()` from `@scribe-sdk/mdx/next-remote`.

## 0.1.0-alpha.2

### Minor Changes

- Ship Scribe’s first public publishing SDK prerelease with publication rendering for content authored in Markdown, MDX, JSX, and semantic HTML; tested Next.js and Vite integration; host-adaptive editorial styles; responsive semantic tables; compile-time Shiki code rendering with code metadata and copy behavior; Banner, Callout, and Figure primitives; actionable validation and diagnostics; a packaged agent-native SKILL.md; and static and server-rendered article guarantees with hydration isolated to copying code.
