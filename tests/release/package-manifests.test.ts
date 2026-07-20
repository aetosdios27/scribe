import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const version = "0.1.0-alpha.5";
const packageNames = ["react", "styles", "mdx", "cli"] as const;
const packageFiles = {
  react: ["dist", "README.md", "SKILL.md", "LICENSE"],
  styles: ["foundation.css", "default.css", "tailwind.css", "README.md", "SKILL.md", "LICENSE"],
  mdx: ["dist", "README.md", "SKILL.md", "LICENSE"],
  cli: ["dist", "README.md", "SKILL.md", "LICENSE"]
} as const;

describe("publishable package manifests", () => {
  it("pins audited dependency overrides for workspace and consumer fixtures", async () => {
    const manifest = await readJson(join(root, "package.json"));

    expect(manifest.overrides).toEqual({
      "@types/mdx": "2.0.14",
      "js-yaml": "4.3.0",
      postcss: "8.5.19"
    });
  });

  it.each(packageNames)("hardens @scribe-sdk/%s for npm publication", async (directory) => {
    const manifest = await readJson(join(root, "packages", directory, "package.json"));

    expect(manifest).toMatchObject({
      name: `@scribe-sdk/${directory}`,
      version,
      type: "module",
      license: "Apache-2.0",
      author: "aetosdios27",
      repository: {
        type: "git",
        url: "git+https://github.com/aetosdios27/scribe.git",
        directory: `packages/${directory}`
      },
      homepage: "https://github.com/aetosdios27/scribe#readme",
      bugs: { url: "https://github.com/aetosdios27/scribe/issues" }
    });
    expect(manifest.private).not.toBe(true);
    expect(manifest.description).toBeTypeOf("string");
    expect(manifest.description.length).toBeGreaterThan(20);
    expect(manifest.keywords).toContain("mdx");
    expect(manifest.files).toEqual(packageFiles[directory]);
    expect(manifest.files).not.toEqual(
      expect.arrayContaining(["RELEASING.md", "RELEASE_NOTES.md", "CHANGELOG.md"])
    );
    expect(JSON.stringify(manifest)).not.toMatch(/workspace:|file:|\/home\/|\\Users\\/u);
    expect(manifest.scripts?.postinstall).toBeUndefined();
    expect(Object.keys(manifest.dependencies ?? {})).not.toEqual(
      expect.arrayContaining(["next", "react", "vitest", "@playwright/test"])
    );
  });

  it("keeps the release procedure repository-only without a duplicate release draft", async () => {
    const releasing = await readFile(join(root, "RELEASING.md"), "utf8");

    await expect(access(join(root, "RELEASE_NOTES.md"))).rejects.toThrow();
    expect(releasing).toContain("bunx changeset publish --no-git-tag");
    expect(releasing).toContain("reads the `alpha` dist-tag from `.changeset/pre.json`");
    expect(releasing).toContain("Post-publication smoke tests");
    expect(releasing).toContain("npm view @scribe-sdk/react dist-tags");
    expect(releasing).not.toMatch(/\/home\/|\\Users\\|_authToken|npm_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}/u);
  });

  it("keeps React singular and peer-owned", async () => {
    const manifest = await readJson(join(root, "packages/react/package.json"));
    expect(manifest.peerDependencies).toEqual({ react: "19.2.7" });
    expect(manifest.dependencies?.react).toBeUndefined();
    expect(manifest.sideEffects).toBe(false);
  });

  it("publishes all three explicit stylesheet modes as side effects", async () => {
    const manifest = await readJson(join(root, "packages/styles/package.json"));
    expect(manifest.exports).toEqual({
      "./foundation.css": "./foundation.css",
      "./default.css": "./default.css",
      "./tailwind.css": "./tailwind.css"
    });
    expect(manifest.sideEffects).toEqual([
      "./foundation.css",
      "./default.css",
      "./tailwind.css"
    ]);
  });

  it("publishes only intentional MDX subpaths", async () => {
    const manifest = await readJson(join(root, "packages/mdx/package.json"));
    expect(Object.keys(manifest.exports)).toEqual([".", "./next", "./next-remote", "./remark", "./rehype"]);
    expect(manifest.sideEffects).toBe(false);
    expect(manifest.engines).toEqual({ node: ">=20.19.0" });
    expect(manifest).toMatchObject({
      main: "./dist/index.mjs",
      module: "./dist/index.mjs",
      types: "./dist/index.d.mts"
    });
  });

  it("publishes the CLI as a binary rather than a library API", async () => {
    const manifest = await readJson(join(root, "packages/cli/package.json"));
    expect(manifest.bin).toEqual({ scribe: "./dist/index.mjs", scb: "./dist/index.mjs" });
    expect(manifest.exports).toEqual({});
    expect(manifest.dependencies).toEqual({
      "@base-ui/react": "1.6.0",
      "@fontsource/ibm-plex-mono": "5.2.7",
      "@fontsource/ibm-plex-sans": "5.2.8",
      "@fontsource/ibm-plex-serif": "5.2.7",
      "@mdx-js/mdx": "3.1.1",
      "@mdx-js/rollup": "3.1.1",
      "@mdxeditor/editor": "4.0.4",
      "@scribe-sdk/mdx": version,
      "@scribe-sdk/react": version,
      "@scribe-sdk/styles": version,
      "@vitejs/plugin-react": "6.0.3",
      "class-variance-authority": "0.7.1",
      clsx: "2.1.1",
      lenis: "1.3.25",
      "lucide-react": "1.25.0",
      sonner: "2.0.7",
      "tailwind-merge": "3.6.0",
      vite: "8.1.3"
    });
    expect(manifest.peerDependencies).toEqual({ react: "19.2.7", "react-dom": "19.2.7" });
    expect(manifest.engines).toEqual({ node: ">=20.19.0" });
  });
});

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
}
