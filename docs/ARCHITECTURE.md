# Scribe architecture

## Why Scribe is shaped this way

Scribe removes the frontend and infrastructure tax from publishing technical content on a website the developer owns. That goal creates the central architectural split:

```text
host application                     Scribe
----------------                     ------
routing and deployment               MDX compilation and validation
content location and metadata        semantic publication structure
navigation and analytics             publishing-specific behavior
visual identity and page shell       accessibility and print mechanics
runtime theme choices                production-faithful local Studio
```

The division matters because a publishing SDK is easiest to adopt when it does not ask the host to become a different application. Scribe should improve an article without silently taking ownership of the website around it.

This document is a contributor's mental model. Package READMEs describe how to call the APIs; this document explains why the boundaries exist.

## Invariants

### Source is authoritative

Markdown and MDX are the persisted document model. Studio may project a subset into a Rich Text editor, but it must not become a second source of truth. When an edit cannot be round-tripped safely, Scribe rejects it instead of guessing.

Why: developers chose ordinary source files partly because Git, editors, build systems, and future tools can continue to understand them. Silent rewriting would destroy that advantage.

### The host remains the application

Scribe does not own routing, deployment, metadata policy, analytics, navigation, or the application shell. Its styles are scoped to publication surfaces, and its CLI integration is a reviewed transaction inside the host repository.

Why: the value of Scribe is publishing machinery without platform surrender.

### Compile-time first

Compilation, validation, table normalization, code highlighting, and heading IDs happen at build time where possible. Runtime React is kept to semantic rendering and behavior that genuinely needs a browser.

Why: static publication output is easier to render on servers, inspect, cache, print, and ship without charging every reader for the authoring toolchain.

### Scribe behavior is additive

Host styling should add identity without silently removing Scribe semantics, anchors, copy behavior, table containment, code output, or accessibility mechanics. Full element replacement is not the default adaptation mechanism.

Why: a customization API that disables the publishing machinery makes every integration responsible for rebuilding the thing Scribe exists to provide.

### Compatibility claims require real consumers

Type declarations prove shape, not framework behavior. Framework claims are tested in production Vite and Next.js builds, browser suites, and packed-package consumers.

Why: module graphs, Server/Client Component rules, CSS ordering, bundlers, package exports, and serialization fail outside the type system.

### Optional capability should not become mandatory cost

The four packages separate compiler, runtime, style, and CLI concerns. Browser bundles are scanned to keep compiler-only dependencies such as Shiki, unified, remark, and rehype out of reader-facing output.

Why: local authoring and compilation can be capable without making every published page carry that machinery.

## The four package boundaries

### `@scribe-sdk/mdx`: compile-time publication semantics

The MDX package assembles the canonical compiler options. Its remark stage enables GFM and YAML frontmatter and exposes parsed frontmatter through file data. Its rehype stage validates Scribe component attributes, wraps tables in a keyboard-focusable overflow region, marks wide tables, transforms code fences into static dual-theme Shiki token spans, emits focused diagnostics, and applies stable heading slugs.

The package has separate exports for the generic compiler, `@next/mdx`, `next-mdx-remote/rsc`, and direct remark/rehype integration. Those exports exist because frameworks load compiler plugins differently; they converge on the same Scribe transformations.

The output of this layer is ordinary compiled MDX/HTML structure plus data attributes consumed by React and CSS. It should not depend on browser APIs.

### `@scribe-sdk/react`: the semantic runtime

The React package provides `Publication`, article primitives, and `createScribeComponents()`, the MDX component map. Ordinary Markdown elements are mapped to semantic Scribe elements, while named primitives such as `Callout`, `Banner`, `Figure`, and `CodeFrame` carry publishing behavior that raw HTML alone does not express.

`Publication` establishes the Scribe article boundary. Contributors should not add a second wrapper in framework adapters. Most components are server-compatible markup. Copy interaction is isolated behind a small client component so a code-copy button does not promote the whole article into a client bundle.

This package owns behavior, not a website-wide theme system. A runtime API belongs here when it represents stable publication semantics that cannot be completed at compile time.

### `@scribe-sdk/styles`: publishing mechanics and explicit visual policy

The style package ships three public CSS entry points:

- `foundation.css` supplies containment, overflow, controls, anchors, figures, accessibility, print, and reduced-motion mechanics while inheriting host typography and rhythm.
- `default.css` layers Scribe's complete editorial presentation over Foundation for hosts that explicitly want it.
- `tailwind.css` cooperates with a host `.prose` contract and repairs Scribe-specific code, table, anchor, figure, and control behavior after Tailwind Preflight.

Foundation and Tailwind are adaptation modes. They preserve what CSS can actually inherit: font, color, line height, direction, letter spacing, available width, ancestor theme state, and variables. They cannot reconstruct private classes or non-inherited element styles that a previous renderer attached to individual headings or wrappers.

That limitation is architectural information, not a bug to hide behind a universal theme engine. Established sites may use an explicit CSS bridge today. Future additive slots or narrow renderers must be justified by real integrations and proven without disabling Scribe-owned behavior.

### `@scribe-sdk/cli`: deliberate integration and local authoring

The CLI owns the repository-facing workflow:

- `init` creates a source-owned content launchpad;
- `integrate` detects the host, proposes package and file changes, supports dry-run inspection, applies a reviewed transaction, and verifies the result;
- `import` converts official Medium exports without overwriting existing articles;
- `validate` compiles one source through the Scribe pipeline; and
- `studio` opens the local authoring and preview surface.

The CLI is allowed to understand filesystems, package managers, host configuration, local HTTP, and browser launch behavior. Those concerns do not belong in reader-facing React or compiler packages.

## The publication flow

```text
Markdown / MDX source
        |
        v
remark: GFM + frontmatter
        |
        v
rehype: validation + tables + Shiki + slugs
        |
        v
framework compiler (Next.js, next-mdx-remote, or Vite MDX)
        |
        v
Scribe React component map
        |
        v
semantic article DOM inside Publication
        |
        v
one explicit Scribe style mode + host application CSS
```

Each stage has one reason to exist. Syntax and diagnostics are decided while the source tree is available. React coordinates semantic elements and narrow interactions. CSS owns layout and visual behavior. The host supplies the page around the publication.

Avoid moving work later in the pipeline without a reason. For example, code highlighting is compile-time because tokenization does not need reader state. Copying code is runtime because it requires a browser interaction.

## Semantic component mapping

MDX lets a host map Markdown elements to React components. Scribe uses that mechanism as a semantic bridge, not as an invitation to replace every tag.

The default map ensures headings receive anchor behavior, tables retain publication containment, code output keeps its frame, and named Scribe primitives share predictable structure. A custom map can extend the defaults through `createScribeComponents(overrides)`, but broad replacement creates a compatibility surface across compiler output, runtime props, CSS selectors, accessibility, and framework module graphs.

That is why new renderer contracts require evidence and prior discussion. A missing link adapter and a universal renderer registry are different-sized problems.

## Host preservation

Scribe preserves host identity primarily by doing less:

1. scope publication rules beneath the Scribe boundary;
2. inherit host decisions that naturally inherit;
3. make Foundation mechanically complete but visually restrained;
4. keep Tailwind's `.prose` typography in charge in Tailwind mode; and
5. require explicit bridges for design information that the browser cannot infer.

Default mode is intentionally different: importing it opts into Scribe's editorial measure, hierarchy, rhythm, code, and table presentation.

Host preservation is tested with deliberately hostile host CSS, CSS Modules, Tailwind v3/v4 fixtures, computed-style assertions, and browser behavior. An integration workaround should not be normalized into documentation until we know whether it reveals a Scribe defect.

## Studio and source authority

Studio serves a local application from `127.0.0.1`. Mutations require a random session capability, JSON content type, same-site/origin checks, and the expected host. These controls reduce accidental or cross-site local mutation; they are not a sandbox for untrusted content.

The source-safety flow is conservative:

1. Studio reads a regular UTF-8 file, records its real path, device/inode identity, byte fingerprint, permissions, BOM, and line-ending style.
2. Rich Text projection replaces protected top-level source islands with non-editable placeholders.
3. A candidate edit must contain every placeholder exactly once and in the original order.
4. Rehydrated source must preserve protected bytes and structure, parse, and compile through Scribe.
5. Client mutations are serialized against a revision; stale writers are rejected.
6. Before saving, Studio rechecks the real path, symlink target, inode, and byte fingerprint.
7. It writes and syncs a temporary file, atomically renames it, syncs the directory, and verifies the committed bytes.

Protected islands currently include frontmatter, MDX imports/exports, JSX, HTML, expressions, directives, unknown syntax, and code fences whose language or metadata could be damaged by a visual editor. Mixed or bare carriage-return line endings are refused rather than normalized silently. External edits become conflicts and recovery state rather than being overwritten.

Why so defensive? Source corruption is categorically worse than an editor declining an edit. Contributors changing these paths should prefer explicit refusal and recovery over a clever transform whose correctness is uncertain.

## Framework and browser boundaries

The generic MDX pipeline is framework-neutral, but integrations are not fictionally identical.

Next.js resolves serialized plugin references, React Server Components impose module-graph and serialization rules, Vite has a different build graph, and browser engines differ in layout and interaction details. TypeScript can validate a component prop shape; it cannot inspect a component body and prove that it is server-safe.

The repository therefore contains production fixtures for:

- Vite;
- Next.js with `@next/mdx`;
- `next-mdx-remote/rsc`;
- Next.js plus CSS Modules;
- Tailwind v3; and
- Tailwind v4.

Portable browser behavior runs in Playwright-managed Chromium and Firefox. WebKit remains an investigative command, not a current compatibility claim. Studio has a separate browser flow because its local server, leases, source validation, save, recovery, and external-edit behavior form a different boundary from published articles.

## Diagnostics

Diagnostics are part of the compiler contract. Scribe uses stable `SCB` identifiers for conditions such as invalid component variants, missing banner alt text, unsupported languages, malformed code metadata, and unsafe Rich Text candidates.

A useful diagnostic says what is wrong, points at source where possible, and tells the author what contract was expected. Do not convert a condition into silent fallback merely to make compilation continue. Strict mode intentionally turns selected compatibility warnings into failures.

## Package exports and bundles

Public entry points are enumerated in each package's `exports` map and covered by release tests. Published files are limited to built output, canonical README/SKILL documentation, and the license. The four packages move as one Changesets fixed group so integrations do not receive mismatched alpha versions.

Release verification builds declarations with TypeScript 7 and TypeScript 6, packs tarballs, inspects manifests and contents, installs them in isolated Bun and npm consumers, exercises public imports and the CLI, and scans browser bundles for compiler-only or Node payloads.

Why test tarballs when workspace tests pass? Workspaces can hide missing files, invalid export maps, `workspace:*` ranges, undeclared dependencies, and accidental source imports. Consumers install archives, so archives are the final package contract.

## The visual contract

Visual behavior is not “just CSS” in a publishing system. Article measure, overflow, heading anchors, code contrast, table containment, print output, focus treatment, and responsive behavior affect whether technical content is usable.

Portable suites assert semantics and layout invariants. Helium Chromium 150 on the maintainer's controlled machine owns canonical pixel baselines because font rasterization differs across operating systems. A baseline is evidence of an intentional contract, not an obstacle to update when CI turns red.

## How to place a change

When deciding where code belongs, follow the earliest responsible layer:

- source meaning, validation, normalization, syntax diagnostics: `@scribe-sdk/mdx`;
- semantic React structure or browser interaction: `@scribe-sdk/react`;
- publication layout, tokens, print, motion, or a style mode: `@scribe-sdk/styles`;
- repository mutation, package-manager work, validation commands, Studio, or local I/O: `@scribe-sdk/cli`;
- host routing, metadata, analytics, navigation, or page shell: the host application, not Scribe.

Then ask what proves it. A claim without the right fixture is still only a theory.
