---
name: scribe
description: Use when integrating, authoring, converting, validating, or troubleshooting Scribe technical articles in React websites using Next.js or Vite, with content authored in Markdown, MDX, JSX, or semantic HTML.
---

# Integrating Scribe

## Principle

Use Scribe as publishing infrastructure inside the website the user already owns. Preserve its routing, deployment, content files, fonts, colors, spacing, and identity.

The host owns visual design. Scribe owns publishing structure and behavior.

When a broad request says to install Scribe or make a blog better, the default result is the existing host design with stronger publishing mechanics. Proceed with that preservation contract; do not stop to ask how extensively to redesign the site. Ask only when the repository contains genuinely conflicting visual directions or the requested change would alter product identity.

Prefer ordinary Markdown and semantic HTML. Use Scribe-specific components only when richer semantics or metadata are genuinely required.

Treat unexpected integration workarounds as possible Scribe defects. Do not silently patch around them in the host application.

Scribe is not a CMS, hosted platform, website builder, rich-text editor, proprietary format, collaboration system, or replacement for React, Next.js, HTML, or MDX.

Scribe is in public alpha. Package versions may use prerelease SemVer identifiers while the API is still evolving.

## Inspect before changing

1. Read the host repository instructions.
2. Identify React, Next.js or Vite, MDX versions, package manager, component-map location, global stylesheet entry, theme mechanism, and production build command.
3. Inspect the host’s fonts and CSS tokens. Reuse them; do not impose a Scribe font or redesign the site.
4. Find one representative article containing headings, code, tables, and images.
5. Confirm installed Scribe packages and keep their prerelease versions aligned.

Expected packages are `@scribe-sdk/react`, `@scribe-sdk/styles`, `@scribe-sdk/mdx`, and development-only `@scribe-sdk/cli`. Read the installed Scribe README and `SKILL.md` before integrating. Depending on the installed package, these are available under paths such as `node_modules/@scribe-sdk/react/README.md` and `node_modules/@scribe-sdk/react/SKILL.md`. Use the packaged copies rather than relying on remembered APIs.

## Integrate the compiler

Start with the deliberate detector:

```bash
bunx scribe init --dry-run
```

Review the detected stack, recommended mode, touched files, commands, ambiguities, and existing highlighter warnings. Run `bunx scribe init` only after the plan is safe. Installation itself is inert.

Choose exactly one style mode:

| Host | Mode |
| --- | --- |
| Established article typography | `foundation.css` |
| Raw site with no article design | `default.css` |
| Tailwind Preflight or Typography `.prose` | `tailwind.css` |

Keep the host’s `.prose` wrapper in Tailwind mode. Do not map font roles to monospace or add compensating host CSS to imitate the pre-integration typography.

For Next.js, configure the existing `@next/mdx` integration:

```js
import createMDX from "@next/mdx";
import { createScribeNextMdxOptions } from "@scribe-sdk/mdx/next";

const withMDX = createMDX({ options: createScribeNextMdxOptions() });
export default withMDX({
  pageExtensions: ["js", "jsx", "md", "mdx", "ts", "tsx"]
});
```

Create or update `mdx-components.tsx`:

```tsx
import { createScribeComponents } from "@scribe-sdk/react";
import type { ScribeComponents } from "@scribe-sdk/react";

export function useMDXComponents(components: ScribeComponents): ScribeComponents {
  return createScribeComponents({ components });
}
```

For Vite, place the MDX plugin before React:

```ts
import mdx from "@mdx-js/rollup";
import { createScribeMdxOptions } from "@scribe-sdk/mdx";
import react from "@vitejs/plugin-react";

plugins: [
  { ...mdx(createScribeMdxOptions()), enforce: "pre" },
  react({ include: /\.(?:js|jsx|md|mdx|ts|tsx)$/ })
]
```

Pass `createScribeComponents()` as the compiled article’s `components` prop in Vite.

For `next-mdx-remote/rsc`, use its dedicated server-compilation adapter—not the `@next/mdx` loader helper:

```tsx
import { createScribeRemoteMdxOptions } from "@scribe-sdk/mdx/next-remote";
import { createScribeComponents } from "@scribe-sdk/react";
import { MDXRemote } from "next-mdx-remote/rsc";

<MDXRemote
  source={source}
  options={createScribeRemoteMdxOptions()}
  components={createScribeComponents()}
/>
```

Preserve the host’s existing MDX options and plugins. Append the `remarkPlugins` and `rehypePlugins` arrays returned by the appropriate Scribe helper to the host’s existing arrays instead of replacing unrelated remark or rehype behavior. Do not create a second MDX compilation pipeline.

Import the selected packaged stylesheet once from the host application shell. Do not copy Scribe CSS into the host.

## Compose articles

Use Markdown headings, paragraphs, links, lists, blockquotes, inline code, thematic breaks, images, and GFM tables normally. Preserve literal semantic JSX and HTML. Do not mechanically replace standard elements with proprietary components.

Use `Publication` directly only for JSX-authored articles. Do not wrap an MDX article in a second `Publication`; the Scribe MDX component map already supplies the article boundary.

Use richer components for metadata HTML cannot express cleanly:

```mdx
<Banner
  eyebrow="Building Styx · Part 3"
  title="The peer wire protocol"
  description="How peers negotiate piece movement"
  image="/peer-wire.svg"
  imageAlt="Two peers exchanging framed messages"
  metadata="12 min read · Rust"
/>

<Callout variant="insight" title="Allocation, not punishment">
  Choking controls upload capacity; it does not close the connection.
</Callout>

<Figure caption="The prefix covers the ID and payload." wide>
  <img src="/piece-frame.svg" alt="Peer-wire message byte layout" />
</Figure>
```

Only `note`, `insight`, and `warning` are valid Callout variants. When Banner has a static `image`, provide non-empty `imageAlt`. Keep image rendering framework-neutral unless the host already owns an image component; override `img` through the component map instead of adding a Next.js dependency to Scribe.

Write semantic tables. Retain `<caption>`, `<thead>`, `<tbody>`, `<th>`, alignment, and inline code. Scribe normalizes Markdown and literal JSX tables into accessible horizontal overflow regions. Do not convert tables to cards or wrap an already normalized `.scribe-table-scroll` table again.

## Author code

Use fenced code, not runtime highlighting components:

````mdx
```rust filename="src/peer.rs" lineNumbers highlight="2-4" focus="2-6" add="5" remove="3"
pub enum PeerState {
    Choked,
    Interested,
}
```
````

Use only these metadata forms:

| Metadata | Accepted form |
| --- | --- |
| filename | `filename="path/file.rs"` |
| line numbers | `lineNumbers` |
| highlighted lines | `highlight="2,4-6"` |
| focused lines | `focus="2,4-6"` |
| added lines | `add="2,4-6"` |
| removed lines | `remove="2,4-6"` |

Ranges are one-based, comma-separated, and inclusive. Shiki runs at compile time only. Never add a browser highlighter, grammar loader, theme payload, WASM engine, or second highlighting path. Unsupported languages warn and render as plaintext; strict mode turns that warning into an error.

## Adapt to the host

Prefer the host aliases Scribe already inherits: `--font-body`, `--font-heading`, `--font-mono`, `--background`, `--foreground`, `--muted-foreground`, `--border`, `--accent`, `--card`, `--muted`, and `--radius`.

Override documented `--scribe-*` tokens on `.scribe` or an ancestor only when the host needs an explicit mapping. Common adjustments are body, heading and code fonts; background, foreground, muted, border and accent colors; radius; content width; wide width; and gutter. Do not bundle fonts or create a theme system.

Scribe supplies color-scheme-aware styles. The host owns the runtime light/dark toggle. Tailwind mode recognizes Tailwind's conventional ancestor `.dark` class and keeps Shiki's foreground/background pair coherent. Set `data-theme="light"` or `data-theme="dark"` on `Publication` only when integrating with another host toggle; an explicit publication theme takes precedence.

## Validate

Run:

```bash
bunx scribe validate path/to/article.mdx
bunx scribe validate path/to/article.mdx --strict
```

With npm, use `npx scribe validate path/to/article.mdx`.

Interpret exit codes as `0` success, `1` article validation failure, and `2` invalid CLI usage. Warnings do not fail unless strict mode requires it. Diagnostics should name the file, position when available, severity, stable code, and remediation.

Then run the host’s strict TypeScript check and production build. Verify both the Scribe article and surrounding host UI in light, dark, narrow, and wide layouts. Confirm tables and code scroll internally without horizontal page overflow.

For an established site, compare computed body font, body size, line height, paragraph margins, H1/H2 scale, content width, and code font before and after. Foundation and Tailwind integration is incomplete if any host-owned value changes without an explicit token override. Inspect screenshots; a green build is not visual proof.

Use Studio for a source-authoritative local editing loop when helpful:

```bash
bunx scribe studio path/to/article.mdx --mode foundation
```

Studio detects the project style mode with the same rules as `scribe init`; use `--mode` only as a deliberate override. Markdown mode edits source beside the production renderer. Rich Text mode is a constrained visual helper whose accepted edits serialize to the canonical Markdown draft; its Markdown mirror is read-only, and unsupported MDX remains a byte-identical protected block that must be edited in Markdown mode. Studio saves explicitly to the displayed article path, warns before closing with unwritten changes, detects external conflicts, and writes atomically. Frontmatter supplies a generated Banner when it includes a title and no explicit Banner exists. Absolute image paths resolve from the project `public` directory, and missing assets remain visible in the preview. Studio is local-only and not a WYSIWYG editor, CMS, or page builder. Use `--host-css` only for one explicit local CSS file and account for framework preprocessing limitations.

## Diagnose the boundary

Classify problems before editing:

- If MDX syntax, Scribe metadata, table normalization, code highlighting, or a Scribe primitive fails in both canonical and host fixtures, treat it as a Scribe product defect.
- If only the host fails, inspect plugin order, duplicate MDX pipelines, missing CSS import, component-map overrides, host global CSS, package version skew, and theme-token values.
- If the host requires routing, metadata, deployment, analytics, content loading, or image optimization work, treat it as host integration—not Scribe rendering.

Reduce defects to ordinary semantic content before adding CSS. Do not introduce custom CSS that conceals broken default behavior. Preserve the source file as the source of truth and avoid unnecessary content transformations.

## Verification checklist

- Confirm all Scribe packages use the same version.
- Confirm the shared MDX helper is active in development and production.
- Confirm the packaged stylesheet is imported once.
- Confirm the selected mode matches the host: foundation for established CSS, default for raw sites, tailwind for `.prose`.
- Confirm host body font, size, line height, paragraph rhythm, heading scale, content width, and code font did not drift.
- Confirm ordinary Markdown and literal JSX tables both scroll on mobile.
- Confirm Shiki output is static and browser bundles contain no highlighter runtime.
- Confirm copy is the only article behavior requiring hydration.
- Confirm host fonts, colors, radius, and theme behavior remain native.
- Run `bunx scribe validate`, strict TypeScript, and the host production build.
- Visually inspect desktop and mobile output before declaring success.
