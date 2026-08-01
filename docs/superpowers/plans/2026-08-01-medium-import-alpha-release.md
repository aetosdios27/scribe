# Medium Import Alpha Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a synchronized Scribe alpha whose npm CLI exposes and successfully runs the Medium importer without hiding downstream dependency advisories.

**Architecture:** Keep the existing Medium importer and Changesets release flow. Correct the consumer dependency graph by upgrading the editor dependency, audit the dependency graph exactly as downstream consumers resolve it, and give the Windows portability smoke enough time and command-level diagnostics to complete or fail usefully.

**Tech Stack:** Bun 1.3.13, npm, TypeScript, Vitest, GitHub Actions, Changesets, npm trusted publishing.

## Global Constraints

- All four public packages remain synchronized in the `0.1.0-alpha.N` fixed group.
- Publication uses the `alpha` dist-tag and never changes `latest`.
- The packed CLI must expose `scribe import` and import a Medium ZIP in a fresh consumer.
- Root workspace overrides must not hide the dependency graph received by npm consumers.
- Windows, Linux, macOS, Chromium, Firefox, and the Linux release gates must pass before merge.

---

### Task 1: Downstream dependency audit fidelity

**Files:**
- Modify: `tests/release/package-manifests.test.ts`
- Modify: `tests/release/ci.test.ts`
- Modify: `packages/cli/package.json`
- Modify: `scripts/audit-public-packages.mjs`
- Modify: `scripts/test-portable-cli.mjs`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: public package manifests and the npm bulk advisory endpoint.
- Produces: `auditPublicPackages()` against an un-overridden consumer dependency tree.

- [ ] **Step 1: Write failing regression assertions**

Assert that `@mdxeditor/editor` is `4.1.1`, that the audit fixture does not copy root overrides, and that the npm portability consumer does not inject a `js-yaml` override.

- [ ] **Step 2: Verify the focused tests fail**

Run: `bunx vitest run tests/release/package-manifests.test.ts tests/release/ci.test.ts`

Expected: failures for editor version and override-masking assertions.

- [ ] **Step 3: Implement the minimal dependency and audit fix**

Upgrade `@mdxeditor/editor` to `4.1.1`, remove root overrides from the audit fixture, remove the npm consumer override, and refresh `bun.lock` with `bun install`.

- [ ] **Step 4: Verify focused tests and production audit**

Run: `bunx vitest run tests/release/package-manifests.test.ts tests/release/ci.test.ts`

Run: `bun run release:audit`

Expected: tests pass; only explicitly accepted Monaco/DOMPurify advisories are reported.

### Task 2: Windows portability completion and diagnostics

**Files:**
- Modify: `tests/release/ci.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/test-portable-cli.mjs`

**Interfaces:**
- Consumes: the portable consumer command runner.
- Produces: bounded command execution with visible command boundaries and a 40-minute OS job budget.

- [ ] **Step 1: Write failing CI contract assertions**

Require the portable OS job to use `timeout-minutes: 40` and require the portability script to define and apply a command timeout while logging command starts.

- [ ] **Step 2: Verify the CI contract test fails**

Run: `bunx vitest run tests/release/ci.test.ts`

Expected: failures for the old 25-minute budget and missing command diagnostics.

- [ ] **Step 3: Implement the minimal reliability fix**

Raise only the portable OS job timeout to 40 minutes. Add a five-minute timeout to each spawned portability command and print the command before execution so Windows failures identify the exact boundary.

- [ ] **Step 4: Verify CI contract and local portability**

Run: `bunx vitest run tests/release/ci.test.ts`

Run: `bun run build && bun run release:pack && bun run test:portability`

Expected: contract passes and the packed CLI imports and validates the generated Medium fixture.

### Task 3: Release verification and publication

**Files:**
- Modify: `.changeset/tidy-medium-imports.md` only if the dependency/audit behavior needs release-note clarification.
- Generated later by Changesets: `packages/*/package.json`, `packages/*/CHANGELOG.md`, `bun.lock`.

**Interfaces:**
- Consumes: PR #19, GitHub CI, Changesets release PR, npm trusted publishing.
- Produces: synchronized npm alpha packages with `scribe import` in the published CLI.

- [ ] **Step 1: Run all repository release gates**

Run the complete checklist in `RELEASING.md`, including typechecks, unit tests, fixture builds, packed consumers, browser suites, Studio flow, release audit, bundle scan, and whitespace checks. Run `release:visual` if Helium is available; otherwise report it as the only locally unavailable gate and rely on the established controlled-machine gate.

- [ ] **Step 2: Review, commit, and push the focused fixes**

Review `git diff`, run CodeRabbit if authenticated, commit only the planned files, and push `agent/automate-alpha-releases`.

- [ ] **Step 3: Wait for PR #19 CI and merge**

Require every GitHub Actions check, including Windows portability, to succeed. Merge PR #19 only after it is mergeable.

- [ ] **Step 4: Verify and merge the Changesets version PR**

Wait for the automated `changeset-release/main` PR, confirm synchronized `0.1.0-alpha.8` manifests and changelogs, require complete CI, then merge it.

- [ ] **Step 5: Verify registry publication**

Confirm all four npm `alpha` tags resolve to the same new version while `latest` remains unchanged. Install the registry packages in a fresh consumer and run `scribe --version`, `scribe import --help`, a Medium ZIP import, and article validation.
