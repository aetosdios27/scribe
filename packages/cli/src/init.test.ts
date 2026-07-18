import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { inspectProject, planInit, runInit } from "./init.js";

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scribe-init-test-"));
  for (const [name, value] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, value);
  }
  return root;
}

const packages = {
  dependencies: {
    react: "19.2.7",
    "@scribe-sdk/react": "0.1.0-alpha.2",
    "@scribe-sdk/styles": "0.1.0-alpha.2",
    "@scribe-sdk/mdx": "0.1.0-alpha.2"
  },
  devDependencies: { "@scribe-sdk/cli": "0.1.0-alpha.2" }
};

it("recommends tailwind when Tailwind Typography and prose usage are detected", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, tailwindcss: "4.3.3", "@tailwindcss/typography": "0.5.20", vite: "8.1.3" } }),
    "bun.lock": "",
    "src/app.tsx": "export const App = () => <article className=\"prose\" />;",
    "src/index.css": "@import 'tailwindcss';\n"
  });

  const inspection = await inspectProject(cwd);
  expect(inspection.packageManager).toBe("bun");
  expect(inspection.tailwindMajor).toBe(4);
  expect(inspection.hasTypographyPlugin).toBe(true);
  expect(inspection.hasProseUsage).toBe(true);
  expect((await planInit(cwd, undefined, "0.1.0-alpha.2")).mode).toBe("tailwind");
});

it("recommends foundation for established custom prose and default for a raw site", async () => {
  const established = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, vite: "8.1.3" } }),
    "package-lock.json": "{}",
    "src/index.css": ".article { max-width: 68ch; font-family: Georgia, serif; line-height: 1.65; }"
  });
  const raw = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, vite: "8.1.3" } }),
    "package-lock.json": "{}",
    "src/index.css": "body { margin: 0; }"
  });

  expect((await planInit(established, undefined, "0.1.0-alpha.2")).mode).toBe("foundation");
  expect((await planInit(raw, undefined, "0.1.0-alpha.2")).mode).toBe("default");
});

it("requires an explicit mode for an ambiguous Tailwind stack", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, tailwindcss: "3.4.19", vite: "8.1.3" } }),
    "src/index.css": "@tailwind base;"
  });

  const plan = await planInit(cwd, undefined, "0.1.0-alpha.2");
  expect(plan.mode).toBeUndefined();
  expect(plan.ambiguities.join(" ")).toContain("--mode");
  expect((await planInit(cwd, "foundation", "0.1.0-alpha.2")).mode).toBe("foundation");
});

it("keeps dry runs pure and reports every proposed change", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, vite: "8.1.3" } }),
    "src/index.css": "body { margin: 0; }\n"
  });
  const before = await readFile(join(cwd, "src/index.css"), "utf8");
  const stdout = vi.fn();

  expect(await runInit(["--dry-run"], { cwd, version: "0.1.0-alpha.2", stdout })).toBe(0);
  expect(await readFile(join(cwd, "src/index.css"), "utf8")).toBe(before);
  expect(stdout.mock.calls.join("\n")).toContain("Scribe public alpha init dry run");
  expect(stdout.mock.calls.join("\n")).not.toContain("beta");
  expect(stdout.mock.calls.join("\n")).toContain("Recommended style mode: default");
  expect(stdout.mock.calls.join("\n")).toContain("src/index.css");
});

it("applies one style import and remains idempotent", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, vite: "8.1.3" } }),
    "src/index.css": "body { margin: 0; }\n"
  });

  expect(await runInit(["--mode", "foundation", "--yes"], { cwd, version: "0.1.0-alpha.2", stdout: vi.fn() })).toBe(0);
  expect(await runInit(["--mode", "foundation", "--yes"], { cwd, version: "0.1.0-alpha.2", stdout: vi.fn() })).toBe(0);
  const css = await readFile(join(cwd, "src/index.css"), "utf8");
  expect(css.match(/@scribe-sdk\/styles\/foundation\.css/gu)).toHaveLength(1);
});

it("keeps the Scribe Tailwind layer after Tailwind v4's required import", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, tailwindcss: "4.3.3", "@tailwindcss/typography": "0.5.20", vite: "8.1.3" } }),
    "src/index.css": "@import \"tailwindcss\";\n@plugin \"@tailwindcss/typography\";\n"
  });

  expect(await runInit(["--mode", "tailwind", "--yes"], { cwd, version: "0.1.0-alpha.2", stdout: vi.fn() })).toBe(0);
  expect(await readFile(join(cwd, "src/index.css"), "utf8")).toMatch(
    /^@import "tailwindcss";\n@import "@scribe-sdk\/styles\/tailwind\.css";\n/u
  );
});

it("creates but never duplicates an unambiguous Next component map", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, next: "16.2.10", "@next/mdx": "16.2.10" } }),
    "app/globals.css": "body { margin: 0; }\n",
    "next.config.mjs": "import createMDX from '@next/mdx';\nexport default createMDX({})({});\n"
  });

  expect(await runInit(["--mode", "default", "--yes"], { cwd, version: "0.1.0-alpha.2", stdout: vi.fn() })).toBe(0);
  expect(await runInit(["--mode", "default", "--yes"], { cwd, version: "0.1.0-alpha.2", stdout: vi.fn() })).toBe(0);
  const components = await readFile(join(cwd, "mdx-components.tsx"), "utf8");
  expect(components.match(/createScribeComponents/gu)).toHaveLength(2);
  expect(components.match(/export function useMDXComponents/gu)).toHaveLength(1);
});

it("names the next-mdx-remote/rsc options prop precisely", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, next: "16.2.10", "next-mdx-remote": "6.0.0" } }),
    "app/globals.css": "body { margin: 0; }\n",
    "app/page.tsx": 'import { MDXRemote } from "next-mdx-remote/rsc"; export default () => <MDXRemote source="# Article" />;'
  });

  const plan = await planInit(cwd, "foundation", "0.1.0-alpha.2");
  expect(plan.manualSteps.join("\n")).toContain("existing MDXRemote options prop");
  expect(plan.manualSteps.join("\n")).not.toContain("compileOptions");
});

it("preserves CRLF files while adding the selected import", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, vite: "8.1.3" } }),
    "src/index.css": "body {\r\n  margin: 0;\r\n}\r\n"
  });

  expect(await runInit(["--mode", "default", "--yes"], { cwd, version: "0.1.0-alpha.2", stdout: vi.fn() })).toBe(0);
  const css = await readFile(join(cwd, "src/index.css"), "utf8");
  expect(css).toContain('default.css";\r\n\r\nbody');
  expect(css.replaceAll("\r\n", "")).not.toContain("\n");
});

it("rejects invalid options and unresolved projects with usage status", async () => {
  const cwd = await project({ "package.json": JSON.stringify({ dependencies: { react: "19.2.7" } }) });
  expect(await runInit(["--mode", "loud"], { cwd, version: "0.1.0-alpha.2", stderr: vi.fn() })).toBe(2);
  expect(await runInit(["--dry-run"], { cwd, version: "0.1.0-alpha.2", stderr: vi.fn() })).toBe(2);
});
