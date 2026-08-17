# Scribe

Scribe is an open-source publishing SDK that turns ordinary Markdown, MDX, semantic HTML, and JSX into beautiful technical articles on websites you already own.

> Just write. Scribe handles the rest.

Scribe is for developers who already own a React website built with Next.js or Vite and want publication-grade typography, code, tables, banners, callouts, figures, responsive behavior, and accessibility without assembling a publishing design system themselves. It transforms semantic article content at build time and renders it through a small React component map plus scoped CSS.

Scribe is not a hosted blogging platform, CMS, website builder, rich-text editor, proprietary content format, collaboration service, or replacement for React, Next.js, MDX, routing, deployment, analytics, or content storage.

## Packages

| Package | Purpose | Public entry points |
| --- | --- | --- |
| `@scribe-sdk/react` | Publication boundary, component map, and editorial primitives | package root |
| `@scribe-sdk/styles` | Scoped publishing mechanics and optional editorial presentation | `/foundation.css`, `/default.css`, `/tailwind.css` |
| `@scribe-sdk/mdx` | Shared compile-time MDX configuration and validation | package root, `/next`, `/next-remote`, `/remark`, `/rehype` |
| `@scribe-sdk/cli` | Validation, deliberate setup, and the local authoring Studio | `scribe` binary |

Each installed package includes the same canonical `SKILL.md`. Agents can discover it at `node_modules/@scribe-sdk/<package>/SKILL.md`; the repository source of truth is [`SKILL.md`](./SKILL.md).

## Install

The recommended path bootstraps through the beta CLI. It installs the four Scribe packages, connects Scribe to the project, and verifies the result as one reviewed transaction:

```bash
bunx @scribe-sdk/cli@beta integrate --dry-run   # inspect the proposed plan
bunx @scribe-sdk/cli@beta integrate             # review, confirm, and apply
```

With npm:

```bash
npx @scribe-sdk/cli@beta integrate --dry-run    # inspect the proposed plan
npx @scribe-sdk/cli@beta integrate              # review, confirm, and apply
```

## Quickstart

```bash
bunx scribe studio init      # create a minimal article and open the local Studio
bunx scribe validate ./content/article.mdx   # compile and validate before shipping
```

`scribe studio init` detects the content directory, writes minimal frontmatter, and opens Studio so you can write and save the article. `scribe validate` compiles it through the production pipeline before you run the host project's build.

## Documentation

Full guides live at **[scribeit.dev/docs](https://scribeit.dev/docs)**, including:

- [Getting Started](https://scribeit.dev/docs/getting-started) — install, first integration checklist, project-local CLI
- [CLI Reference](https://scribeit.dev/docs/cli-reference) — every command and flag
- [Style Modes](https://scribeit.dev/docs/style-modes) — Foundation, Default, and Tailwind
- [Next.js Integration](https://scribeit.dev/docs/nextjs) and [Vite Integration](https://scribeit.dev/docs/vite)
- [Components](https://scribeit.dev/docs/components) — Publication, Banner, Callout, Figure, Video, code fences, Mermaid
- [Local Studio](https://scribeit.dev/docs/studio) — the source-authoritative Markdown/MDX editor
- [Theming & CSS Tokens](https://scribeit.dev/docs/theming) — the full token reference
- [Validate & Troubleshoot](https://scribeit.dev/docs/troubleshooting)
- [Migrating from `0.1.0-alpha.2`](https://scribeit.dev/docs/migration)
- [Compatibility & Responsibility Boundary](https://scribeit.dev/docs/compatibility)

Scribe 0.1.0-beta is a public beta. The API may evolve before a stable release.

## License

Licensed under Apache-2.0. See [`LICENSE`](./LICENSE).
