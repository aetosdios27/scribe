import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("public CI contract", () => {
  it("defines read-only, cancellable Linux, OS, and browser jobs", async () => {
    const workflow = await text(".github/workflows/ci.yml");

    expect(workflow).toContain("pull_request:");
    expect(workflow).toMatch(/push:\s*\n\s*branches:\s*\n\s*- main/u);
    expect(workflow).toMatch(/permissions:\s*\n\s*contents: read/u);
    expect(workflow).toContain("group: ci-${{ github.workflow }}-${{ github.ref }}");
    expect(workflow).toContain("cancel-in-progress: true");
    expect(workflow).toContain("verify-linux:");
    expect(workflow).toContain("portable-os:");
    expect(workflow).toContain("browser-engines:");
    expect(workflow).toContain("fail-fast: false");
    for (const value of ["ubuntu-latest", "windows-latest", "macos-latest"]) {
      expect(workflow).toContain(value);
    }
    for (const value of ["chromium", "firefox"]) {
      expect(workflow).toContain(value);
    }
    expect(workflow).not.toMatch(/^\s+- webkit$/mu);
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("oven-sh/setup-bun@v2");
    expect(workflow).toContain('bun-version: "1.3.13"');
    expect(workflow).not.toMatch(/npm[_-]?token|NODE_AUTH_TOKEN|changesets\/action|npm publish/iu);
  });

  it("documents WebKit as unverified rather than a release gate", async () => {
    const releasing = await text("RELEASING.md");

    expect(releasing).toContain("WebKit and Safari behavior are not verified for this release");
    expect(releasing).toContain("bun run test:browser:chromium");
    expect(releasing).toContain("bun run test:browser:firefox");
    expect(releasing).not.toContain("Run portable Chromium, Firefox, and WebKit behavior tests");
  });

  it("builds public packages before workspace typechecks resolve their dist exports", async () => {
    const workflow = await text(".github/workflows/ci.yml");
    const verifyLinux = workflow.slice(workflow.indexOf("  verify-linux:"), workflow.indexOf("  portable-os:"));
    const portableOs = workflow.slice(workflow.indexOf("  portable-os:"), workflow.indexOf("  browser-engines:"));

    for (const job of [verifyLinux, portableOs]) {
      expect(job.indexOf("Build public packages")).toBeGreaterThan(-1);
      expect(job.indexOf("Typecheck with TypeScript 7")).toBeGreaterThan(-1);
      expect(job.indexOf("Build public packages")).toBeLessThan(job.indexOf("Typecheck with TypeScript 7"));
    }
  });

  it("exposes separate portable browser and canonical Helium commands", async () => {
    const manifest = JSON.parse(await text("package.json"));

    expect(manifest.scripts).toMatchObject({
      "test:browser": "playwright test --config playwright.config.ts",
      "test:browser:chromium": "playwright test --config playwright.config.ts --project=chromium",
      "test:browser:firefox": "playwright test --config playwright.config.ts --project=firefox",
      "test:browser:webkit": "playwright test --config playwright.config.ts --project=webkit",
      "test:visual:helium": "node scripts/run-helium-visual.mjs",
      "release:visual": "node scripts/run-helium-visual.mjs --require-helium",
      "test:portability": "node scripts/test-portable-cli.mjs",
      "portability:check": "node scripts/check-portability.mjs"
    });
  });

  it("runs the Studio browser flow in hosted Chromium without making it a visual baseline", async () => {
    const workflow = await text(".github/workflows/ci.yml");

    expect(workflow).toContain("bun run test:studio:browser");
    expect(workflow).toContain("matrix.browser == 'chromium'");
  });

  it("keeps portable Playwright independent from Helium", async () => {
    const portable = await text("playwright.config.ts");
    const helium = await text("playwright.helium.config.ts");
    const portableSuite = await text("tests/browser/article.spec.ts");
    const visualSuite = await text("tests/visual/article.spec.ts");

    expect(portable).toContain('testDir: "./tests/browser"');
    expect(portable).toContain('{ name: "chromium"');
    expect(portable).toContain('{ name: "firefox"');
    expect(portable).toContain('{ name: "webkit", workers: 1');
    expect(portable).not.toContain("helium");
    expect(portable).not.toContain("toHaveScreenshot");
    expect(helium).toContain('name: "helium-chromium-150"');
    expect(helium).toContain('testDir: "./tests/visual"');
    expect(helium).not.toContain(["/usr/bin", "/helium"].join(""));
    expect(portableSuite).not.toContain("document.fonts.ready");
    expect(portableSuite).not.toContain("image.decode()");
    expect(visualSuite).toContain("document.fonts.ready");
    expect(visualSuite).toContain("image.decode()");
  });

  it("contains no stale scope or maintainer path and isolates the Helium executable", async () => {
    const files = await repositoryFiles(root);
    const occurrences: Array<{ file: string; value: string }> = [];
    const maintainerPath = ["/home", "/aetos"].join("");
    const fixedTempPath = ["/tmp", "/"].join("");
    const heliumPath = ["/usr/bin", "/helium"].join("");

    for (const file of files) {
      const content = await readFile(join(root, file), "utf8");
      for (const value of [["@scribe", "/"].join(""), maintainerPath, fixedTempPath]) {
        if (content.includes(value)) occurrences.push({ file, value });
      }
      if (content.includes(heliumPath) && file !== "scripts/run-helium-visual.mjs") {
        occurrences.push({ file, value: heliumPath });
      }
    }

    expect(occurrences).toEqual([]);
  });
});

async function text(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}

async function repositoryFiles(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", ".next", ".scribe-local", ".scribe-pack", ".scribe-release", "dist", "node_modules", "out", "playwright-report", "test-results"].includes(entry.name)) continue;
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await repositoryFiles(join(directory, entry.name), relative));
    else if (entry.isFile() && /\.(?:json|md|mjs|ts|tsx|yml|yaml)$/u.test(entry.name)) files.push(relative);
  }
  return files;
}
