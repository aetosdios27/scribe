# Scribe release procedure

Run this procedure from the repository root. Publishing, tagging, pushing, and creating a GitHub release are separate owner actions after every generated change and artifact has been reviewed.

## Release-note source of truth

Scribe uses this flow:

```text
.changeset/*.md
→ bunx changeset version
→ packages/*/CHANGELOG.md
→ GitHub release description
```

Do not maintain a duplicate root `RELEASE_NOTES.md`. Derive the GitHub release description from the generated package changelogs, combining duplicate fixed-group entries into one readable release summary. Changeset fragments and generated changelogs remain public repository files but are excluded from npm tarballs.

## During development

Add one fragment for each meaningful consumer-facing change:

```bash
bunx changeset
```

Select every affected public package. The fixed group keeps `@scribe-sdk/react`, `@scribe-sdk/styles`, `@scribe-sdk/mdx`, and `@scribe-sdk/cli` version-aligned even when a fragment directly names only part of the group.

Scribe’s pre-1.0 semver policy is:

- `patch`: a backward-compatible bug fix, diagnostic improvement, or behavior correction that affects consumers.
- `minor`: a new backward-compatible capability, or a breaking public API change while Scribe remains in `0.x`. Breaking summaries must say what changed and how to migrate.
- `major`: reserved for an intentional stable-major transition after an explicit owner decision. Do not select it for routine alpha work.

Internal refactors, tests, spelling fixes, and repository-only work do not require a fragment unless they alter published behavior.

A good summary describes observable user impact in clear present-tense language, names the capability or compatibility change, and can be understood without the diff. Avoid internal ticket language, implementation-only detail, marketing exaggeration, and vague text such as “misc fixes.” Mention breaking changes and required migration steps directly.

Good:

> Add compile-time code highlighting with filename labels, line numbers, focused lines, diffs, and plaintext fallback for unsupported languages.

Bad:

> Refactor highlighter pipeline.

Good:

> Reject unknown Callout variants during validation with an actionable diagnostic.

Bad:

> Fix validation.

## Inspect unreleased changes

Run:

```bash
bunx changeset status --verbose
bun run release:check
```

Status shows the fragments and proposed versions. The release check fails if public versions drift, a package leaves the fixed group, an internal range conflicts, a public manifest contains `workspace:*`, the CLI hard-codes its version, or documentation references conflicting prerelease versions.

## Alpha prerelease mode

The repository is currently in alpha prerelease mode. `.changeset/pre.json` records that state and must be reviewed with other release files.

The one-time command used to enter this cycle is:

```bash
bunx changeset pre enter alpha
```

Do not repeat it for each alpha. Add normal Changeset fragments during the cycle. `bunx changeset version` consumes new fragments and advances all fixed packages to the next `0.1.0-alpha.N` version. The prerelease tag for new versions is `alpha`, and `latest` is repointed at the newest published alpha after each publication so the public package pages and tagless installs reflect the current build.

## Automated release path

The `Release` GitHub Actions workflow runs only after the complete `CI` workflow succeeds for a push to `main`. It never runs for pull requests, failed CI, cancelled CI, or manually dispatched CI. The workflow has two deterministic outcomes:

1. When unreleased Changeset fragments exist, it creates or updates the ready `changeset-release/main` version pull request, synchronizes package versions and changelogs, refreshes `bun.lock`, and dispatches CI for that exact release branch.
2. When a verified version pull request has been merged and no unreleased fragments remain, it rebuilds and inspects the packages, then runs Scribe's guarded publisher. The publisher requires alpha prerelease mode, publishes each inspected tarball with an explicit `--tag alpha`, skips versions already on npm, publishes the CLI last, waits for each dist-tag to converge, and points `latest` at the newest published version.

Publishing uses npm trusted publishing through GitHub OIDC. No npm write token, OTP, or `NODE_AUTH_TOKEN` belongs in GitHub secrets.

Before the first automated publication, complete these one-time owner settings:

1. In GitHub, allow Actions to create pull requests under **Settings → Actions → General → Workflow permissions**. Keep branch protection and required CI checks enabled.
2. For each of `@scribe-sdk/styles`, `@scribe-sdk/react`, `@scribe-sdk/mdx`, and `@scribe-sdk/cli`, configure the npm trusted publisher with:
   - provider: GitHub Actions
   - organization or user: `aetosdios27`
   - repository: `scribe`
   - workflow filename: `release.yml`
   - environment: blank
   - allowed action: `npm publish`
3. Do not add an npm automation token. The workflow uses Node 24, npm 11.6.2, a GitHub-hosted runner, and `id-token: write` so npm can exchange the job identity for a short-lived publishing credential.

The workflow intentionally creates no Git tag or GitHub release. Those remain explicit owner decisions after registry verification.

## Generate versions and changelogs

The automated version pull request runs the equivalent of:

```bash
bunx changeset version
bun install
bun run release:check
```

`changeset version` consumes applicable fragments, synchronizes package versions, updates internal dependency ranges, and creates or updates `packages/*/CHANGELOG.md`. Review every generated manifest and changelog entry. `bun install` refreshes the lockfile after manifest changes.

The curated bootstrap fragment generated `0.1.0-alpha.2` from the already prepared `0.1.0-alpha.1` manifests. In prerelease mode Changesets retains that fragment and records it as consumed in `.changeset/pre.json`. Future alpha fragments advance the synchronized prerelease sequence. Use an isolated repository copy for destructive workflow rehearsals.

## Compatibility verification model

GitHub CI smoke-tests package installation, declarations, builds, and the CLI on Linux, Windows, and macOS. Required portable browser behavior runs against Playwright-managed Chromium and Firefox. WebKit and Safari behavior are not verified for this release, so do not claim Safari compatibility. The local WebKit command remains available for investigation but is not a release gate. Chromium-family products are covered primarily through the Chromium engine suite.

Helium Chromium 150 remains the canonical pixel-regression environment on the maintainer’s controlled machine. Contributors and Scribe users do not need Helium: it is not packaged or used at runtime. Host fonts can rasterize differently across operating systems, so portable tests guarantee semantic behavior and layout invariants rather than identical glyph pixels.

Run the portable suites with:

```bash
bun run test:browser:chromium
bun run test:browser:firefox
```

The optional WebKit diagnostic command is:

```bash
bun run test:browser:webkit
```

When Helium is installed locally, run the canonical article and visual-continuity snapshots with:

```bash
bun run test:visual:helium
```

That contributor convenience command exits successfully with a clear skip message when Helium is absent. Release verification must instead use the strict command:

```bash
bun run release:visual
```

The release command fails clearly when Helium is unavailable. Do not update the Helium baselines to address a portable-engine difference; first determine whether the difference violates a semantic or layout invariant.

## Verification gates

After versioning, run every gate from the repository root:

- [ ] Confirm the branch and reviewed working tree: `git status --short --branch`
- [ ] Install exactly: `bun install --frozen-lockfile`
- [ ] Verify canonical package docs: `bun run docs:check`
- [ ] Verify fixed-group alignment and release policy: `bun run release:check`
- [ ] Scan for stale scopes, fixed machine paths, and misplaced Helium references: `bun run portability:check`
- [ ] Run TypeScript 7 strict checking: `bun run typecheck`
- [ ] Run TypeScript 6 with library checking enabled: `node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`
- [ ] Run unit, transformation, diagnostics, and release tests: `bun run test`
- [ ] Build all packages: `bun run build`
- [ ] Build Vite for production: `bun run --cwd tests/integration/vite build`
- [ ] Build Next.js for production: `bun run --cwd tests/integration/next build`
- [ ] Build `next-mdx-remote/rsc` for production: `bun run --cwd tests/integration/next-remote build`
- [ ] Build the packed `next-mdx-remote/rsc` consumer through `bun run release:consumers`
- [ ] Inspect npm dry runs: `bun run release:pack:dry`
- [ ] Create local tarballs: `bun run release:pack`
- [ ] Inspect tarball contents, manifests, declarations, README, SKILL, LICENSE, and repository-only exclusions: `bun run release:inspect`
- [ ] Install the packed tarballs and smoke-test portable CLI paths: `bun run test:portability`
- [ ] Run isolated packed Vite and Next consumers with Bun and npm: `bun run release:consumers`
- [ ] Check the packaged CLI version and help from the packed consumer: `bunx scribe --version` and `bunx scribe --help`
- [ ] Validate valid and invalid article fixtures through the packaged CLI
- [ ] Run required portable browser behavior: `bun run test:browser:chromium` and `bun run test:browser:firefox`
- [ ] Run the Studio edit, save, invalid-source, and recovery flow: `bun run test:studio:browser`
- [ ] Review foundation, Tailwind v3, and Tailwind v4 computed-style continuity assertions in both portable browser suites
- [ ] Run the canonical Helium Chromium 150 visual suite in required mode: `bun run release:visual`
- [ ] Visually inspect every PNG under `tests/visual/screenshots/` without regenerating baselines
- [ ] Inspect browser bundles for Shiki, Oniguruma, grammar, theme, MDX, unified, remark, rehype, Node, and WASM payloads: `bun run release:bundle-scan`
- [ ] Confirm `SKILL.md` exists in every intended package tarball
- [ ] Execute README installation commands unchanged in a fresh packed consumer
- [ ] Scan repository release files for secrets and machine-specific paths
- [ ] Audit published-package production dependencies: `bun run release:audit`
- [ ] Run whitespace validation last: `git diff --check`

## Publish

Before publication, confirm `npm whoami` reports the intended account and that it may publish public packages in the `@scribe-sdk` scope. Keep credentials and one-time passwords outside the repository.

Changesets owns versioning and changelogs; it does not publish Scribe packages. After all gates pass, the automated workflow publishes the inspected tarballs with:

```bash
bun run release:packages
```

The publisher verifies `.changeset/pre.json`, synchronized `0.1.0-alpha.N` manifests, and the npm dist-tags. It publishes only missing `.scribe-release/*.tgz` artifacts, explicitly passes `npm publish --tag alpha --access public`, waits for the `alpha` dist-tag to converge, then repoints `latest` at the published version and waits for that to converge too. npm authenticates the commands from the workflow's OIDC identity.

Do not execute this command manually during ordinary release preparation. Manual publication remains an emergency fallback after diagnosing a failed automated release. Run it from an interactive terminal so npm can open its browser/passkey challenge; never paste a credential into the repository or CI logs. Publish tarballs in the documented order—styles, React, MDX, then CLI—and always include `--tag alpha --access public`. For each package, verify the `alpha` dist-tag resolves to the published version, then explicitly repoint `latest` with `npm dist-tag add @scribe-sdk/<name>@<version> latest` and verify `latest` resolves to that version before continuing, matching the publisher's convergence checks.

## Post-publication smoke tests

Verify registry metadata and confirm all four packages resolve to the same alpha version:

```bash
npm view @scribe-sdk/react dist-tags
npm view @scribe-sdk/styles dist-tags
npm view @scribe-sdk/mdx dist-tags
npm view @scribe-sdk/cli dist-tags
npm view @scribe-sdk/react versions --json
npm view @scribe-sdk/styles versions --json
npm view @scribe-sdk/mdx versions --json
npm view @scribe-sdk/cli versions --json
```

In a fresh consumer, install only the published alpha packages:

```bash
bun add @scribe-sdk/react@alpha @scribe-sdk/styles@alpha @scribe-sdk/mdx@alpha
bun add --dev @scribe-sdk/cli@alpha
bunx scribe --version
bunx scribe --help
bunx scribe validate path/to/article.mdx
```

Run that consumer’s strict typecheck and production build. Confirm each installed `node_modules/@scribe-sdk/*/package.json` reports the same version before creating any Git tag or GitHub release.

## Stable release later

Do not leave prerelease mode until Scribe is intentionally ready for a stable release. At that point:

```bash
bunx changeset pre exit
bunx changeset version
```

Review the stable versions and generated changelogs, refresh the lockfile, and rerun every verification gate. Publish stable packages only after a separate owner review; publish without `--tag alpha` and repoint `latest` so the deliberate stable release replaces the newest alpha as `latest`.
