# Contributing to Scribe

If you found a problem and cared enough to inspect Scribe, you are welcome here.

Scribe is young, and its maintainers would rather review a well-observed integration fix than a grand redesign. Bring the problem, understand the change, show the evidence, and own what you submit.

## What we want help with

The strongest contributions usually come from using Scribe to publish something real. We especially welcome:

- integration bugs and compatibility fixes;
- accessibility fixes;
- clearer diagnostics;
- documentation corrections based on actual confusion;
- source-safety fixes;
- performance regressions;
- missing technical-publishing primitives;
- browser, package, release, and framework test improvements; and
- small features grounded in a real publishing need.

Practical use is strong evidence. “I needed this while publishing this article in this application” is a better starting point than “a publishing SDK could theoretically support this.” A focused issue with a reproduction is also a valuable contribution, even when you do not have a safe fix.

## Send the patch or discuss it first?

If the contract is already obvious, send the patch. Bug fixes, regression tests, accessibility repairs, documentation improvements, small implementation corrections, and contained additions with clear product semantics generally do not need advance permission.

Open a [feature or integration proposal](https://github.com/aetosdios27/scribe/issues/new?template=feature_integration.yml) before substantial implementation when a change affects:

- a public API or package export;
- MDX syntax or compiler semantics;
- renderer or styling architecture;
- framework support;
- the source trust model or filesystem/network boundaries;
- a major runtime dependency;
- broad visual behavior;
- CLI contracts;
- versioning or migration guarantees; or
- a broad new abstraction.

This is not an approval ritual. It prevents a contributor and maintainer from independently designing incompatible public contracts. Bring the integration problem and the smallest surface you think solves it. A prototype can help explain an idea, but do not expect a large speculative implementation to substitute for agreement on the contract.

## The product boundary

The host owns the website. Scribe owns the publishing machinery.

The host application keeps control of routing, deployment, content location, metadata, analytics, navigation, visual identity, typography, colors, spacing, and runtime theme choices. Scribe compiles MDX and coordinates semantic publication structure, Scribe component behavior, code presentation, responsive publishing mechanics, tables, anchors, validation, diagnostics, accessibility behavior it introduces, print behavior, and production-faithful local authoring support.

That split is a design constraint, not positioning copy. Adding Scribe should not quietly transfer ownership of the application shell. A feature that belongs in one website's router, metadata system, analytics, or design system usually belongs in that host.

Scribe should not casually become a hosted CMS, site builder, proprietary document format, generic collaboration product, giant theme engine, universal element-replacement API, or abstraction factory. The question is not only whether an idea is useful. The question is whether Scribe is the right layer to own it.

## Before you build

Ask three questions:

1. What actual problem am I solving?
2. Does that problem belong in Scribe?
3. What is the smallest correct surface?

Demonstrated need comes before abstraction. Do not build a plugin framework because one component is missing, a universal renderer API because one site needs a different image, or configuration merely because configuration is possible. Solve the observed case cleanly. Generalize only when multiple real cases reveal the same contract.

## Repository map

Scribe is a Bun workspace with four version-aligned public packages:

- `@scribe-sdk/mdx` owns the compile-time MDX pipeline: GFM and frontmatter parsing, Scribe validation, table normalization, Shiki code output, heading slugs, and the Next.js and `next-mdx-remote` adapters.
- `@scribe-sdk/react` owns the publication boundary, semantic component map, and Scribe runtime primitives. Most output is server-compatible markup; the copy button is kept as a narrow client island.
- `@scribe-sdk/styles` owns scoped publishing mechanics and three explicit modes: Foundation, Default, and Tailwind. Foundation and Tailwind adapt to host visual policy; Default is the opt-in editorial preset.
- `@scribe-sdk/cli` owns `scribe init`, `integrate`, `import`, `validate`, and the local Studio. Studio is part of the CLI package, not a separate hosted application.

`tests/integration/` contains real Vite, Next.js, `next-mdx-remote`, Tailwind v3/v4, and CSS Modules consumers. Portable Playwright suites cover browser behavior and Studio flows. The release scripts pack the public packages, inspect their public surface, install their tarballs into isolated Bun and npm consumers, and scan browser bundles. These are not decorative fixtures: they are where compatibility claims become evidence.

For the reasoning behind these boundaries, read [Architecture](./docs/ARCHITECTURE.md).

## Development setup

Scribe uses Bun 1.3.13 in CI. From the repository root:

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run test
```

During development, run the narrowest useful test first. Vitest accepts a file path or test-name filter, for example:

```bash
bunx vitest run packages/mdx/src/transform.test.ts
bunx vitest run packages/cli/src/studio-files.test.ts
bunx vitest run -t "rejects source and host CSS paths"
```

Before submitting, choose checks based on what changed:

| Change | Relevant checks |
| --- | --- |
| Package source or exports | `bun run build`, `bun run typecheck`, `bun run test` |
| Canonical package README/SKILL/LICENSE | `bun run docs:check` |
| MDX or React browser behavior | `bun run test:browser:chromium`; use `bun run test:browser:firefox` when engine behavior matters |
| CSS Modules host preservation | `bun run test:browser:next-css-modules` |
| Studio server, editor, save, or recovery flow | focused CLI tests, then `bun run test:studio:browser -- --project=chromium` |
| Published appearance | `bun run test:visual:helium`; see [Visual changes](#visual-changes) |
| Changesets, manifests, exports, CI, or release scripts | `bun run test:release`, `bun run release:check`, and the relevant release test file |
| Packed public artifacts or consumer installs | `bun run release:pack`, `bun run release:inspect`, `bun run test:portability`, or `bun run release:consumers`, depending on the contract touched |
| Browser bundle composition | `bun run release:bundle-scan` |

The complete release procedure in [RELEASING.md](./RELEASING.md) is an owner checklist, not the default contributor loop. WebKit is available for investigation with `bun run test:browser:webkit`, but it is not a current public-alpha release gate. The Helium visual command skips clearly when the maintainer's canonical browser is not installed.

## Tests are evidence

A test is not there to make CI green. It should prove the behavioral contract.

Bug fixes should normally include regression evidence. Establish that the regression test fails against the broken or base behavior and passes with the change. Say how you established both sides in the pull request. This is especially important for generated or AI-assisted tests: a new test that only ever passed may not exercise the bug at all.

Prefer a focused semantic assertion to a large brittle snapshot. Use the layer where the behavior is real:

- compiler behavior belongs in an MDX transformation or diagnostic test;
- runtime component behavior belongs in React or browser coverage;
- host integration belongs in a real framework fixture when possible;
- source preservation belongs in Studio file, transaction, or browser-flow coverage;
- published-package behavior belongs against packed tarballs, not workspace aliases; and
- appearance changes belong in visual evidence plus the relevant semantic/layout assertions.

If no automated test can express the contract, explain why and provide reproducible manual evidence.

## Visual changes

Published appearance is part of Scribe's product contract. If a change materially affects it, explain:

- why the appearance changes;
- which style modes are affected;
- which viewports are affected;
- whether this fixes an objective defect or intentionally changes presentation;
- before and after screenshots; and
- why any visual baseline update represents the intended contract.

“Updated snapshots because CI failed” is not a rationale. Review the diff. Host fonts may rasterize differently across operating systems, so portable browser tests focus on semantic and layout invariants while Helium Chromium 150 owns canonical pixel baselines.

## Public API changes

Discuss public API changes before implementation. A proposal should answer:

1. What real integration problem exists?
2. Why can the current API not solve it?
3. What is the smallest new surface that solves it?
4. What compatibility cost does it create?
5. How will it be verified in an actual consumer?

Type declarations alone do not prove framework compatibility. If a contract claims to work across a Next.js Server/Client Component boundary or in a production Vite build, prove it in those environments.

## Dependencies

A runtime dependency has permanent installation, security, bundle, licensing, and maintenance cost. If you add one, explain why it belongs, why the existing stack is insufficient, and what reaches consumer bundles. Optional capabilities should stay behind optional package or import boundaries rather than charging every user a mandatory runtime cost.

## Source safety

Markdown and MDX files remain authoritative. Studio's Rich Text mode is a projection over canonical source, not a second document format.

Today, Studio protects frontmatter, JSX, HTML, imports and exports, expressions, directives, comments/unknown syntax, and code-fence metadata from lossy Rich Text transforms. A candidate Rich Text edit must retain protected islands in order and byte content, parse again, and compile successfully before it can replace the draft. Studio also refuses mixed line endings, detects external changes and changed symlink targets, serializes revisions, and performs a durable temporary-file write with byte verification.

These guards are deliberately conservative. Where correctness is uncertain, refusal is better than silently damaging user source. Changes to source classification, round-tripping, conflict detection, workspace path containment, recovery, or write behavior require focused regression evidence.

Studio is for trusted local project content. Loopback binding and mutation capabilities reduce local network exposure; they do not sandbox executable MDX.

## AI use

Scribe is not anti-AI. Engineers use Claude Code, Codex, Cursor, GitHub Copilot, ChatGPT, local models, and other coding agents. Used well, they can accelerate exploration, implementation, debugging, and review. The quality bar does not move.

### AI is a tool, not the contributor

The human submitting a pull request owns its correctness, licensing, security implications, design choices, tests, documentation, and reviewer responses. “Claude wrote it” is never an explanation.

### Human understanding is mandatory

You must understand the change well enough to explain what it does, why it is designed that way, its important invariants and failure modes, its tradeoffs, and why the tests demonstrate correctness. You do not need encyclopedic knowledge of every dependency. You must not act as a proxy carrying messages between a reviewer and a model.

### Disclose non-trivial assistance

At pull-request level, state the tool or tools used, the model/version if useful and known, and the rough scope of assistance: codebase exploration, implementation, test generation, debugging, documentation, refactoring, or review.

Disclosure is not required for deterministic formatters, spelling correction, tiny IDE completions, boilerplate autocomplete, or research where no meaningful generated output entered the contribution. Scribe does not currently require an `Assisted-by:` commit trailer. PR-level disclosure is enough; governance can become more specific if the project later needs it.

### Human communication should remain human

Issue reports, pull-request descriptions, design explanations, and reviewer replies should represent your reasoning. AI may edit, translate, improve grammar, or help structure your thoughts, but do not paste model-generated answers back and forth between yourself and maintainers.

If genuinely useful generated context must be shown, quote the relevant part, label it as AI-generated, and follow it with your explanation of why it matters. Maintainers want to interact with the engineer responsible for the work.

### State your unknowns

Uncertainty is useful review information. It is fine to say, “I believe this is safe, but I do not know whether this serialization path changes the RSC boundary.” Identify uncertainty introduced by AI-assisted exploration rather than bluffing. That lets review focus where it is most valuable.

### AI-assisted tests need extra skepticism

If AI produced or materially assisted with a regression test, verify that the test:

1. fails against the broken or base behavior; and
2. passes with the proposed change.

A passing generated test, without that check, proves very little.

### No autonomous contribution bots

Scribe does not accept contributions where an unsupervised agent chooses an issue, selects a design, generates the patch, opens the pull request, and responds to review without a responsible human engineer actively driving and understanding the work. Human-driven interactive coding agents are welcome. Autonomous contribution spam is not.

### Protect review bandwidth

Large speculative patches, hallucinated APIs, verbose generated commentary, unnecessary abstractions, fake tests, or work the author cannot explain may be closed without detailed review. Maintainer review is a scarce project resource. The author shares the burden of showing that a contribution deserves it.

If you find a problem in an area you do not understand well enough to change safely, file a strong issue instead. A minimal reproduction, observed and expected behavior, environment details, and a failing case are more valuable than a speculative generated fix.

## Changesets and releases

Add a Changeset for a meaningful consumer-facing change:

```bash
bunx changeset
```

The four public packages are a fixed version group. Select the directly affected packages and write a concise summary of observable user impact. Backward-compatible fixes and diagnostic improvements use the repository's current `patch` intent; backward-compatible features and pre-1.0 breaking public changes use `minor`, with migration details for breaking changes.

Internal refactors, tests, contributor documentation, spelling fixes, and repository-only work normally do not need a Changeset unless they alter published behavior. See [.changeset/README.md](./.changeset/README.md) and [RELEASING.md](./RELEASING.md) for the actual prerelease and owner workflow. Do not version or publish packages as part of an ordinary contribution.

## Pull requests

A strong pull request explains:

- the problem;
- what changed;
- why this scope is the smallest appropriate one;
- what public behavior changes; and
- what demonstrates correctness.

Keep it focused. One change should tell one story. Do not combine a feature, broad refactor, formatting pass, and unrelated fixes because they happened nearby.

## Review

Review protects the product contract; it is not a defense of the maintainer's original code. Expect attention to correctness, scope, semantics, host preservation, source safety, accessibility, framework boundaries, bundle behavior, compatibility, and test evidence.

A request for a smaller API is not necessarily rejection of the feature. Often the underlying need is good enough to deserve a contract maintainers can actually support.

Bring the problem. Show the evidence. Build the smallest correct thing.
