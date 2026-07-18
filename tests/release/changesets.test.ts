import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const publicPackages = ["@scribe-sdk/react", "@scribe-sdk/styles", "@scribe-sdk/mdx", "@scribe-sdk/cli"] as const;
const packageDirectories = ["react", "styles", "mdx", "cli"] as const;

describe("Changesets release policy", () => {
  it("keeps every public package in one fixed public group", async () => {
    const config = await readJson(join(root, ".changeset", "config.json"));

    expect(config).toEqual({
      $schema: "https://unpkg.com/@changesets/config/schema.json",
      changelog: "@changesets/cli/changelog",
      commit: false,
      fixed: [publicPackages],
      linked: [],
      access: "public",
      baseBranch: "main",
      updateInternalDependencies: "patch",
      ignore: []
    });
  });

  it("leaves the real repository in the intentional alpha prerelease cycle", async () => {
    const pre = await readJson(join(root, ".changeset", "pre.json"));

    expect(pre.mode).toBe("pre");
    expect(pre.tag).toBe("alpha");
    expect(pre.changesets).toEqual(["bright-pages-publish", "calm-sites-publish", "steady-studios-close"]);
    expect(pre.initialVersions).toEqual(Object.fromEntries(publicPackages.map((name) => [name, "0.1.0-alpha.1"])));
  });

  it("records one curated bootstrap fragment for the first public prerelease", async () => {
    const fragment = await readFile(join(root, ".changeset", "bright-pages-publish.md"), "utf8");

    for (const name of publicPackages) expect(fragment).toContain(`"${name}": minor`);
    for (const capability of [
      "publication rendering", "Markdown", "MDX", "JSX", "semantic HTML", "Next.js", "Vite",
      "host-adaptive", "responsive semantic tables", "compile-time Shiki", "code metadata",
      "copy", "Banner", "Callout", "Figure", "validation", "diagnostics", "SKILL.md",
      "static and server-rendered"
    ]) {
      expect(fragment).toContain(capability);
    }
  });

  it("keeps package versions and internal public dependencies synchronized", async () => {
    const manifests = await Promise.all(packageDirectories.map((directory) =>
      readJson(join(root, "packages", directory, "package.json"))
    ));
    const versions = new Set(manifests.map((manifest) => manifest.version));

    expect(versions).toEqual(new Set(["0.1.0-alpha.4"]));
    expect(manifests.every((manifest) => manifest.license === "Apache-2.0")).toBe(true);
    expect(manifests.find((manifest) => manifest.name === "@scribe-sdk/cli")?.dependencies).toMatchObject({
      "@scribe-sdk/mdx": "0.1.0-alpha.4",
      "@scribe-sdk/react": "0.1.0-alpha.4",
      "@scribe-sdk/styles": "0.1.0-alpha.4"
    });
    expect(JSON.stringify(manifests)).not.toContain("workspace:");
  });

  it("generates synchronized package changelogs for the bootstrap and public alpha", async () => {
    for (const directory of packageDirectories) {
      const changelog = await readFile(join(root, "packages", directory, "CHANGELOG.md"), "utf8");
      expect(changelog).toContain(`## 0.1.0-alpha.2`);
      expect(changelog).toContain("Ship Scribe’s first public publishing SDK prerelease");
      expect(changelog).toContain(`## 0.1.0-alpha.3`);
      expect(changelog).toContain("Make Scribe's public alpha safe for established React sites");
      expect(changelog).toContain("Existing `default.css` imports remain supported");
      expect(changelog).toContain(`## 0.1.0-alpha.4`);
      if (directory === "mdx" || directory === "cli") {
        expect(changelog).toContain("Restore strict React 19 typechecking for Vite MDX configurations");
      }
      expect(changelog).not.toContain("beta");
    }
  });

  it("provides the supported root commands and deterministic release check", async () => {
    const manifest = await readJson(join(root, "package.json"));

    expect(manifest.scripts).toMatchObject({
      changeset: "changeset",
      "changeset:status": "changeset status",
      "version:packages": "changeset version",
      "release:packages": "changeset publish --no-git-tag",
      "release:check": "node scripts/check-release-alignment.mjs"
    });
    expect(manifest.devDependencies["@changesets/cli"]).toBe("2.31.1");
  });

  it("uses generated changelogs instead of a duplicate root release draft", async () => {
    await expect(access(join(root, "RELEASE_NOTES.md"))).rejects.toThrow();
    const releasing = await readFile(join(root, "RELEASING.md"), "utf8");

    expect(releasing).toContain("bunx changeset");
    expect(releasing).toContain("bunx changeset status");
    expect(releasing).toContain("bunx changeset pre enter alpha");
    expect(releasing).toContain("bunx changeset version");
    expect(releasing).toContain("bunx changeset publish --no-git-tag");
    expect(releasing).not.toContain("changeset publish --tag alpha");
    expect(releasing).toContain("bunx changeset pre exit");
    expect(releasing).toContain("observable user impact");
    expect(releasing).toContain("packages/*/CHANGELOG.md");
  });
});

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
}
