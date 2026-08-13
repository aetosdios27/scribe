import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const packageNames = ["react", "styles", "mdx", "cli"] as const;
const packageFiles = {
  react: ["dist", "README.md", "SKILL.md", "LICENSE"],
  styles: ["foundation.css", "default.css", "tailwind.css", "README.md", "SKILL.md", "LICENSE"],
  mdx: ["dist", "README.md", "SKILL.md", "LICENSE"],
  cli: ["dist", "README.md", "SKILL.md", "LICENSE"]
} as const;
const nativeDirectories = [
  "linux-x64-gnu",
  "linux-x64-musl",
  "linux-arm64-gnu",
  "linux-arm64-musl",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64-msvc",
  "win32-arm64-msvc"
] as const;

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
    const version = await currentPublicVersion();

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
    expect(releasing).toContain("bun run release:packages");
    expect(releasing).toContain("The automated publisher does not mutate `latest`");
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
    const version = await currentPublicVersion();
    expect(manifest.bin).toEqual({ scribe: "./dist/bootstrap.mjs", scb: "./dist/bootstrap.mjs" });
    expect(manifest.exports).toEqual({});
    expect(manifest.dependencies).toEqual({
      "@base-ui/react": "1.6.0",
      "@cloudflare/kumo": "2.8.0",
      "@fontsource/ibm-plex-mono": "5.2.7",
      "@fontsource/ibm-plex-sans": "5.2.8",
      "@fontsource/ibm-plex-serif": "5.2.7",
      "@mdx-js/mdx": "3.1.1",
      "@mdx-js/rollup": "3.1.1",
      "@mdxeditor/editor": "4.1.1",
      "@phosphor-icons/react": "2.1.10",
      "@scribe-sdk/mdx": version,
      "@scribe-sdk/react": version,
      "@scribe-sdk/styles": version,
      "@vitejs/plugin-react": "6.0.3",
      "class-variance-authority": "0.7.1",
      clsx: "2.1.1",
      fflate: "0.8.3",
      lenis: "1.3.25",
      "lucide-react": "1.25.0",
      "monaco-editor": "0.56.0",
      "rehype-parse": "9.0.1",
      "rehype-remark": "10.0.1",
      "remark-gfm": "4.0.1",
      "remark-stringify": "11.0.0",
      sonner: "2.0.7",
      "tailwind-merge": "3.6.0",
      unified: "11.0.5",
      vite: "8.1.3"
    });
    expect(manifest.peerDependencies).toEqual({ react: "19.2.7", "react-dom": "19.2.7" });
    expect(manifest.engines).toEqual({ node: ">=20.19.0" });
    expect(Object.keys(manifest.optionalDependencies)).toEqual(
      nativeDirectories.map((directory) => `@scribe-sdk/cli-${directory}`)
    );
    expect(new Set(Object.values(manifest.optionalDependencies))).toEqual(new Set([version]));
  });

  it.each(nativeDirectories)("publishes one constrained native CLI package for %s", async (directory) => {
    const manifest = await readJson(join(root, "packages/cli-native", directory, "package.json"));
    const binary = directory.startsWith("win32") ? "bin/scribe-cli.exe" : "bin/scribe-cli";
    expect(manifest).toMatchObject({
      name: `@scribe-sdk/cli-${directory}`,
      version: await currentPublicVersion(),
      license: "Apache-2.0",
      files: [binary, "build-metadata.json", "LICENSE"]
    });
    expect(manifest.os).toHaveLength(1);
    expect(manifest.cpu).toHaveLength(1);
    expect(manifest.private).not.toBe(true);
  });
});

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
}

async function currentPublicVersion(): Promise<string> {
  const manifest = await readJson(join(root, "packages", "react", "package.json"));
  return manifest.version as string;
}
