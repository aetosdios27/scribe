# Scribe

Scribe is an open-source publishing SDK that turns ordinary Markdown, MDX, semantic HTML, and JSX into beautiful technical articles on websites you already own.

> Just write. Scribe handles the rest.

Scribe is for developers who already own a React website built with Next.js or Vite and want publication-grade typography, code, tables, banners, callouts, figures, responsive behavior, and accessibility without assembling a publishing design system themselves. It transforms semantic article content at build time and renders it through a small React component map plus scoped CSS.

Scribe is not a hosted blogging platform, CMS, website builder, rich-text editor, proprietary content format, collaboration service, or replacement for React, Next.js, MDX, routing, deployment, analytics, or content storage. The public alpha is tested against React 19.2.7, Next.js 16.2.10, Vite 8.1.3, and MDX 3.1.1. Broader compatibility will be validated through real integrations.

## Packages

| Package | Purpose | Public entry points |
| --- | --- | --- |
| `@scribe-sdk/react` | Publication boundary, component map, and editorial primitives | package root |
| `@scribe-sdk/styles` | Scoped publishing mechanics and optional editorial presentation | `/foundation.css`, `/default.css`, `/tailwind.css` |
| `@scribe-sdk/mdx` | Shared compile-time MDX configuration and validation | package root, `/next`, `/next-remote`, `/remark`, `/rehype` |
| `@scribe-sdk/cli` | Validation, deliberate setup, and the local authoring Studio | `scb` binary |

Each installed package includes the same canonical `SKILL.md`. Agents can discover it at `node_modules/@scribe-sdk/<package>/SKILL.md`; the repository source of truth is [`SKILL.md`](./SKILL.md).

## Install

With Bun:

```bash
bun add @scribe-sdk/react@alpha @scribe-sdk/styles@alpha @scribe-sdk/mdx@alpha
bun add --dev @scribe-sdk/cli@alpha
```

With npm:

```bash
npm install @scribe-sdk/react@alpha @scribe-sdk/styles@alpha @scribe-sdk/mdx@alpha
npm install --save-dev @scribe-sdk/cli@alpha
```

Package installation is inert: it does not edit source files, run project detection, or make network calls beyond normal package-manager behavior. Inspect a proposed integration explicitly:

```bash
bunx scb init --dry-run
```

## Choose a style mode

The host owns design; Scribe owns structure and behavior. Import one stylesheet from the application shell:

| Mode | Use when | Import |
| --- | --- | --- |
| Foundation | The site already owns article typography, density, and width | `@scribe-sdk/styles/foundation.css` |
| Default | The site needs a complete editorial preset | `@scribe-sdk/styles/default.css` |
| Tailwind | Tailwind Preflight or Typography owns a `.prose` contract | `@scribe-sdk/styles/tailwind.css` |

Foundation supplies containment, overflow, controls, anchors, figures, accessibility, print, and reduced-motion mechanics while inheriting host typography and rhythm. Default layers Scribe’s polished editorial scale on those mechanics. Tailwind preserves the host’s `.prose` typography while repairing code-frame, table, anchor, figure, and control behavior after Preflight.

For a raw site:

```tsx
import "@scribe-sdk/styles/default.css";
```

For a Tailwind Typography site, keep the existing `.prose` wrapper and load Scribe after Tailwind’s CSS entry:

```css
@import "tailwindcss";
@import "@scribe-sdk/styles/tailwind.css";
@plugin "@tailwindcss/typography";
```

Scribe ships no fonts and does not clone Tailwind Typography. In Tailwind mode, compiled Shiki foreground and background colors remain paired so the host's prose code background cannot make highlighted code unreadable. Tailwind's conventional ancestor `.dark` class selects the dark pair; an explicit `data-theme="light"` or `data-theme="dark"` on `Publication` takes precedence.

## Initialize an existing project

Run initialization deliberately after installation:

```bash
bunx scb init --dry-run
bunx scb init
```

`init` inspects React, Next.js or Vite, Tailwind v3/v4, Typography and `.prose`, existing MDX integrations and plugins, syntax highlighters, global CSS, component maps, and current Scribe wiring. It recommends `foundation`, `default`, or `tailwind`, reports every proposed command and file edit, and asks before mutation. Use `--mode foundation|default|tailwind` to override the recommendation or `--yes` for a reviewed non-interactive plan.

Initialization is minimal and idempotent. It does not replace existing remark/rehype plugins or remove another highlighter automatically; ambiguous configuration becomes a precise manual step. Roll back by reverting only the files listed in its completion report and removing the displayed packages.

## Next.js MDX integration

The tested Next.js path uses Next 16.2.10 and React 19.2.7. Install Next’s MDX integration if the host does not already have it:

```bash
bun add @next/mdx@16.2.10 @mdx-js/loader@3.1.1 @mdx-js/react@3.1.1
```

Configure the shared Scribe compiler in `next.config.mjs`:

```js
import createMDX from "@next/mdx";
import { createScribeNextMdxOptions } from "@scribe-sdk/mdx/next";

const withMDX = createMDX({
  options: createScribeNextMdxOptions()
});

export default withMDX({
  pageExtensions: ["js", "jsx", "md", "mdx", "ts", "tsx"]
});
```

Add `mdx-components.tsx` at the application root:

```tsx
import { createScribeComponents } from "@scribe-sdk/react";
import type { ScribeComponents } from "@scribe-sdk/react";

export function useMDXComponents(components: ScribeComponents): ScribeComponents {
  return createScribeComponents({ components });
}
```

Import the CSS from the root layout and render an article normally:

```tsx
import "@scribe-sdk/styles/default.css";
import Article from "./article.mdx";

export default function Page() {
  return <Article />;
}
```

The component map supplies `Publication` as the MDX wrapper, so individual Markdown elements do not need manual wrappers.

## Next.js with `next-mdx-remote/rsc`

`next-mdx-remote/rsc` compiles source through a server/runtime API, not the `@next/mdx` loader. Use its dedicated adapter directly in the `MDXRemote` `options` prop:

```tsx
import { createScribeRemoteMdxOptions } from "@scribe-sdk/mdx/next-remote";
import { createScribeComponents } from "@scribe-sdk/react";
import { MDXRemote } from "next-mdx-remote/rsc";

export function RemoteArticle({ source }: { source: string }) {
  return (
    <MDXRemote
      source={source}
      options={createScribeRemoteMdxOptions({ strict: true })}
      components={createScribeComponents()}
    />
  );
}
```

Do not pass `createScribeNextMdxOptions()` here; that helper emits the serializable loader-oriented shape for `@next/mdx`. Preserve one compilation pipeline. If the host already has remark or rehype behavior, merge its plugin arrays with the arrays inside `createScribeRemoteMdxOptions().mdxOptions` rather than mounting a second `MDXRemote` pass.

## Vite MDX integration

The tested Vite path uses Vite 8.1.3, React 19.2.7, `@mdx-js/rollup` 3.1.1, and `@vitejs/plugin-react` 6.0.3:

```bash
bun add @mdx-js/rollup@3.1.1 @vitejs/plugin-react@6.0.3
```

Configure `vite.config.ts`:

```ts
import mdx from "@mdx-js/rollup";
import { createScribeMdxOptions } from "@scribe-sdk/mdx";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    { ...mdx(createScribeMdxOptions()), enforce: "pre" },
    react({ include: /\.(?:js|jsx|md|mdx|ts|tsx)$/ })
  ]
});
```

Pass the map to the compiled article:

```tsx
import { createScribeComponents } from "@scribe-sdk/react";
import "@scribe-sdk/styles/default.css";
import Article from "./article.mdx";

const components = createScribeComponents();

export function App() {
  return <Article components={components} />;
}
```

## Render the first article

Copy [`examples/starter-article.mdx`](https://github.com/aetosdios27/scribe/blob/main/examples/starter-article.mdx) into the host’s content directory and [`examples/starter-diagram.svg`](https://github.com/aetosdios27/scribe/blob/main/examples/starter-diagram.svg) into its public directory. It demonstrates ordinary Markdown, a banner, a callout, a code fence, a responsive table, and a figure without requiring custom article CSS.

Ordinary Markdown and semantic HTML receive the best default rendering:

```mdx
# Peer state

The peer starts as `choked` until the remote side grants upload capacity.

| State | Meaning |
| --- | --- |
| `choked` | Piece requests are paused. |
```

Headings receive stable slug IDs at compile time and an unobtrusive accessible anchor. Tables remain semantic and are normalized into keyboard-focusable horizontal overflow regions. Literal JSX `<table>` markup receives the same treatment and is never converted into mobile cards.

## Supported primitives

### Publication

`Publication` establishes the semantic `<article class="scribe">` boundary. Use it directly for JSX articles; MDX receives it automatically through the component map.

```tsx
import type { ReactNode } from "react";
import { Publication } from "@scribe-sdk/react";

export function Article({ children }: { children: ReactNode }) {
  return <Publication>{children}</Publication>;
}
```

Standard article attributes are forwarded. The MDX-only `components` prop is consumed and never leaks into the DOM.

### Banner

```mdx
<Banner
  eyebrow="Building Styx · Part 3"
  title="The peer wire protocol"
  description="How peers negotiate the movement of pieces"
  image="/peer-wire.svg"
  imageAlt="Two peers exchanging framed protocol messages"
  metadata="12 min read · Rust"
/>
```

`title` is required. `description`, `eyebrow`, `metadata`, `accent`, `imagePosition`, and children are optional. A static `image` requires a non-empty `imageAlt`. Omit both image properties for a text-only banner.

### Callout

```mdx
<Callout variant="insight" title="Allocation, not punishment">
  Choking controls upload capacity; it does not close the connection.
</Callout>
```

Supported variants are `note`, `insight`, and `warning`. Unknown static variants fail MDX validation with an actionable diagnostic.

### Figure and responsive images

```mdx
<Figure caption="The length prefix covers the message ID and payload." wide>
  <img src="/piece-frame.svg" alt="Byte layout of a peer-wire message" />
</Figure>
```

Scribe renders framework-neutral semantic `<figure>`, `<figcaption>`, and `<img>` elements. A host may override `img` through `createScribeComponents` to use its framework image component:

```tsx
const components = createScribeComponents({
  components: {
    img: SiteImage
  }
});
```

### Code fences

Shiki runs only during MDX compilation. The browser receives static highlighted HTML plus a small copy-button client component.

````mdx
```rust filename="src/peer.rs" lineNumbers highlight="2-4" focus="2-6" add="5" remove="3"
pub enum PeerState {
    Choked,
    Interested,
}
```
````

Supported metadata is explicit:

| Field | Syntax | Effect |
| --- | --- | --- |
| filename | `filename="src/peer.rs"` | Displays a filename in the code frame |
| line numbers | `lineNumbers` | Displays line numbers |
| highlight | `highlight="2,4-6"` | Emphasizes lines |
| focus | `focus="2,4-6"` | Focuses lines and de-emphasizes others |
| additions | `add="4-6"` | Marks added lines |
| removals | `remove="2"` | Marks removed lines |

Ranges are one-based, comma-separated, and inclusive. Unknown or malformed fields fail compilation. Unsupported languages warn and fall back to plaintext by default. Enable strict behavior with `createScribeMdxOptions({ strict: true })`, `createScribeNextMdxOptions({ strict: true })`, or `scb validate article.mdx --strict`.

Inline backticks remain visually distinct from framed code blocks.

## Customize Scribe to the host

Set tokens on the publication boundary or an ancestor. Scribe first reads common host tokens such as `--font-body`, `--foreground`, and `--accent`, then uses neutral fallbacks. It does not bundle fonts or own the host’s theme switch.

```css
.site-article {
  --scribe-font-body: "Source Serif 4", serif;
  --scribe-font-heading: "Inter", sans-serif;
  --scribe-font-code: "Berkeley Mono", ui-monospace, monospace;
  --scribe-background: transparent;
  --scribe-foreground: #171714;
  --scribe-accent: #7c3aed;
  --scribe-border: color-mix(in oklab, currentColor 18%, transparent);
  --scribe-radius: 0.4rem;
}
```

### CSS token reference

| Token | Value type and purpose | Foundation / default value | Example |
| --- | --- | --- | --- |
| `--scribe-font-body` | font-family for prose | `var(--font-body, inherit)` | `"Source Serif 4", serif` |
| `--scribe-font-heading` | font-family for headings | `var(--font-heading, inherit)` | `Inter, sans-serif` |
| `--scribe-font-code` | font-family for code | `var(--font-mono, ui-monospace, "SFMono-Regular", Consolas, monospace)` | `"Berkeley Mono", monospace` |
| `--scribe-background` | article background color | `var(--background, transparent)` | `#fff` |
| `--scribe-foreground` | primary text color | `var(--foreground, currentColor)` | `#171714` |
| `--scribe-muted` | secondary text color | `var(--muted-foreground, color-mix(in oklab, currentColor 62%, transparent))` | `#686862` |
| `--scribe-border` | rules and component borders | `var(--border, color-mix(in oklab, currentColor 16%, transparent))` | `#deded8` |
| `--scribe-accent` | links, anchors, and emphasis | `var(--accent, currentColor)` | `#7c3aed` |
| `--scribe-surface` | subtle component surface | `var(--card, color-mix(in oklab, currentColor 4%, transparent))` | `#fafaf7` |
| `--scribe-surface-strong` | stronger header or control surface | `var(--muted, color-mix(in oklab, currentColor 8%, transparent))` | `#f0f0eb` |
| `--scribe-selection` | text selection background | accent mixed to 22% | `rgb(124 58 237 / 22%)` |
| `--scribe-content-width` | main reading measure | `100%` / `70ch` | `66ch` |
| `--scribe-wide-width` | maximum breakout width | `100%` / `min(92rem, calc(100vw - 2rem))` | `80rem` |
| `--scribe-radius` | component corner radius | `var(--radius, 0.5rem)` / `var(--radius, 0.75rem)` | `0.4rem` |
| `--scribe-gutter` | responsive article gutter | `0px` / `clamp(1rem, 4vw, 2.5rem)` | `clamp(1rem, 3vw, 2rem)` |
| `--scribe-rule` | horizontal rule thickness | `1px` | `2px` |
| `--scribe-body-size` | article body font size | `inherit` / `clamp(1rem, 0.97rem + 0.15vw, 1.075rem)` | `1rem` |
| `--scribe-leading` | prose line height | `inherit` / `1.78` | `1.72` |
| `--scribe-paragraph-spacing` | paragraph block margins | `inherit` / `1.35em 0` | `1em 0` |
| `--scribe-section-spacing` | major heading rhythm | `inherit` / `clamp(3.8rem, 9cqi, 6.5rem)` | `4rem` |
| `--scribe-h1-size` | H1 font size | `inherit` / `clamp(2.35rem, 1.7rem + 2.8cqi, 4.8rem)` | `3rem` |
| `--scribe-h1-spacing` | H1 block margins | `inherit` / `0 1.8rem` | `0 1.5rem` |
| `--scribe-h2-size` | H2 font size | `inherit` / `clamp(1.72rem, 1.45rem + 1.15cqi, 2.55rem)` | `2rem` |
| `--scribe-h2-spacing` | H2 block margins | `inherit` / `var(--scribe-section-spacing) 1.15rem` | `4rem 1rem` |
| `--scribe-h3-size` | H3 font size | `inherit` / `clamp(1.35rem, 1.22rem + 0.55cqi, 1.72rem)` | `1.5rem` |
| `--scribe-h3-spacing` | H3 block margins | `inherit` / `3.15rem 0.9rem` | `2.5rem 0.75rem` |
| `--scribe-code-size` | inline and block code scale | `0.875em` | `0.9em` |
| `--scribe-control-size` | compact control hit-target size | `2rem` | `2.25rem` |
| `--scribe-code-block-padding-block` | code-frame vertical density | `1rem` / `clamp(1rem, 3cqi, 1.45rem)` | `0.875rem` |
| `--scribe-code-block-padding-inline` | code-frame horizontal density | `1rem` / `clamp(1rem, 3cqi, 1.45rem)` | `1.25rem` |
| `--scribe-code-leading` | block-code line height | `1.6` / `1.7` | `1.55` |
| `--scribe-table-cell-padding-block` | table vertical density | `0.625rem` / `0.8rem` | `0.5rem` |
| `--scribe-table-cell-padding-inline` | table horizontal density | `0.75rem` / `clamp(0.85rem, 2.5cqi, 1.25rem)` | `0.75rem` |
| `--scribe-shadow` | restrained code-frame shadow | `0 1.25rem 3rem color-mix(in oklab, #000 12%, transparent)` | `none` |

Scribe follows `prefers-color-scheme` when the host provides no explicit mode. Set `data-theme="light"` or `data-theme="dark"` on `.scribe` when the host already has a runtime toggle. Scribe owns color-scheme-aware article styles; the host owns the toggle, persistence, and application chrome.

Reduced-motion preferences disable nonessential transitions. Print styles remove interactive copy controls and preserve readable code and links.

## Local authoring Studio

Open a source-authoritative local workspace for one Markdown or MDX file:

```bash
bunx scb studio ./content/article.mdx
bunx scb studio ./content/article.mdx --mode foundation --host-css ./src/app/globals.css
```

Studio provides a source pane, real Scribe preview, explicit save, unsaved and external-change conflict states, validation diagnostics, style modes, light/dark previews, and desktop/tablet/mobile widths. It binds to `127.0.0.1`, opens the browser unless `--no-open` is supplied, performs no telemetry, and keeps the file as the source of truth. It is not a WYSIWYG editor and never stores a proprietary document.

MDX is executable local project content; open only files you trust. `--host-css` loads one explicit local stylesheet. It does not crawl the application or reproduce framework processing automatically: Tailwind directives, CSS imports, asset URLs, and fonts may require a separately compiled CSS artifact. Studio writes only after Save, uses an atomic replacement, preserves LF/CRLF line endings, and refuses to overwrite an externally changed file until the conflict is resolved.

Use `--port 4317` to select a port and `--no-open` for headless workflows. Stop the local server with the CLI process.

## Validate and troubleshoot

Validate one article through the production compiler:

```bash
bunx scb validate ./content/article.mdx
bunx scb validate ./content/article.mdx --strict
```

With npm:

```bash
npx scb validate ./content/article.mdx
npx scb validate ./content/article.mdx --strict
```

`scb validate` checks MDX syntax, Scribe code metadata, supported static component metadata, compile-time highlighting, and article-level diagnostics. It does not execute or validate the complete consumer application.

- Exit `0`: validation succeeded; warnings may have been printed.
- Exit `1`: article compilation or strict validation failed.
- Exit `2`: command usage was invalid.

Diagnostics include the file, position when available, severity, stable code, and remediation. Unsupported languages use warning `SCB1003` and plaintext fallback unless strict mode is enabled. Run `scb --help` for the complete supported CLI surface.

If rendering differs between the Vite and Next builds, confirm that both use the matching `@scribe-sdk/mdx` version and the shared helper. If a table is not scrollable, confirm that the stylesheet is imported and the article renders beneath `.scribe`. Do not add host CSS solely to conceal a Scribe defect; reduce the case and report it at <https://github.com/aetosdios27/scribe/issues>.

## Migrating from `0.1.0-alpha.2`

- Existing `default.css` imports remain supported and retain the complete editorial preset.
- Established sites that already own article typography should switch to `foundation.css` after reviewing `scb init --dry-run` and before/after computed styles.
- Tailwind Typography sites should use `tailwind.css` and keep their `.prose` wrapper.
- `next-mdx-remote/rsc` integrations should replace loader-shaped configuration with `createScribeRemoteMdxOptions()` from `@scribe-sdk/mdx/next-remote`.
- Installation performs no migration. `scb init` reports and confirms any safe edits; existing plugins and highlighters remain untouched unless the owner changes them explicitly.

## Responsibility boundary

Scribe owns publication structure, semantic component mappings, responsive article behavior, compile-time highlighting, controls, accessibility mechanics, print behavior, and article diagnostics. The host owns typography, density, colors, visual identity, routing, page metadata, deployment, analytics, content storage, runtime theme switching, and framework-specific image optimization.

Scribe is in public alpha. The API may evolve before a stable release, and framework support remains intentionally narrow while real integrations validate the product.

## License

Licensed under Apache-2.0. See [`LICENSE`](./LICENSE).
