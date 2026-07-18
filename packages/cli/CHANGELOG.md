# @scribe-sdk/cli

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
