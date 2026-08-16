# @scribe-sdk/react

## 0.1.0-beta.3

## 0.1.0-beta.2

## 0.1.0-beta.1

## 0.1.0-beta.0

### Minor Changes

- 0597bf9: Add Mermaid diagram rendering for ` ```mermaid ` code fences, a zoomable lightbox for `ScribeImage` with a `#nozoom` fragment and `zoom={false}` escape hatch, a `Video` component, a word-wrap toggle button on code blocks (with a `wrap` code-fence flag), and `success`/`error` Callout variants.

## 0.1.0-beta

### Patch Changes

- Support `success` and `error` Callout variants.

## 0.1.0-alpha.10

## 0.1.0-alpha.9

## 0.1.0-alpha.8

## 0.1.0-alpha.7

## 0.1.0-alpha.6

## 0.1.0-alpha.5

## 0.1.0-alpha.4

## 0.1.0-alpha.3

### Minor Changes

- Make Scribe's public alpha safe for established React sites: add foundation, default, and Tailwind style modes that preserve host-owned typography; add explicit, idempotent `scb init`; add a dedicated `next-mdx-remote/rsc` adapter; add the local source-authoritative Scribe Studio; and strengthen computed-style and visual-continuity verification.

- Existing `default.css` imports remain supported. Established sites should use `foundation.css`, Tailwind Typography sites should use `tailwind.css`, and `next-mdx-remote/rsc` integrations should use `createScribeRemoteMdxOptions()` from `@scribe-sdk/mdx/next-remote`.

## 0.1.0-alpha.2

### Minor Changes

- Ship Scribe’s first public publishing SDK prerelease with publication rendering for content authored in Markdown, MDX, JSX, and semantic HTML; tested Next.js and Vite integration; host-adaptive editorial styles; responsive semantic tables; compile-time Shiki code rendering with code metadata and copy behavior; Banner, Callout, and Figure primitives; actionable validation and diagnostics; a packaged agent-native SKILL.md; and static and server-rendered article guarantees with hydration isolated to copying code.
