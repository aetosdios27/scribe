import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { inspectProject, planIntegrate, resolveProjectStyleMode, runIntegrate } from "./integrate.js";

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
  expect((await planIntegrate(cwd, undefined, "0.1.0-alpha.2")).mode).toBe("tailwind");
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

  expect((await planIntegrate(established, undefined, "0.1.0-alpha.2")).mode).toBe("foundation");
  expect((await planIntegrate(raw, undefined, "0.1.0-alpha.2")).mode).toBe("default");
});

it("requires an explicit mode for an ambiguous Tailwind stack", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, tailwindcss: "3.4.19", vite: "8.1.3" } }),
    "src/index.css": "@tailwind base;"
  });

  const plan = await planIntegrate(cwd, undefined, "0.1.0-alpha.2");
  expect(plan.mode).toBeUndefined();
  expect(plan.ambiguities.join(" ")).toContain("--mode");
  expect((await planIntegrate(cwd, "foundation", "0.1.0-alpha.2")).mode).toBe("foundation");
});

it("does not misclassify an unrelated two-digit Tailwind major", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, tailwindcss: "^10.3.1", vite: "8.1.3" } }),
    "src/index.css": "@tailwind base;"
  });

  expect((await inspectProject(cwd)).tailwindMajor).toBeUndefined();
});

it("lets Studio's explicit mode override bypass framework recommendation ambiguity", async () => {
  const cwd = await project({ "package.json": JSON.stringify({ private: true }) });

  const resolution = await resolveProjectStyleMode(cwd, "default");
  expect(resolution.mode).toBe("default");
  expect(resolution.ambiguities).toEqual([]);
  expect(resolution.reason).toContain("Selected explicitly");
});

it("keeps dry runs pure and reports every proposed change", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, vite: "8.1.3" } }),
    "src/index.css": "body { margin: 0; }\n"
  });
  const before = await readFile(join(cwd, "src/index.css"), "utf8");
  const stdout = vi.fn();

  expect(await runIntegrate(["--dry-run"], { cwd, version: "0.1.0-alpha.2", stdout })).toBe(0);
  expect(await readFile(join(cwd, "src/index.css"), "utf8")).toBe(before);
  const output = stdout.mock.calls.join("\n");
  expect(output).toContain("Scribe integrate — dry run");
  expect(output).not.toContain("beta");
  expect(output).toMatch(/Detected\n[\s\S]*React 19\.2\.7/u);
  expect(output).toMatch(/Recommendation\n[\s\S]*default/u);
  expect(output).toMatch(/Commands\n/u);
  expect(output).toMatch(/File changes\n[\s\S]*src\/index\.css/u);
  expect(output).toMatch(/Manual steps\n/u);
  expect(output).toMatch(/Next\n/u);
  expect(output).not.toContain(cwd);
});

it("separates detected integration warnings from manual steps", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, vite: "8.1.3", "rehype-pretty-code": "0.14.1" } }),
    "src/index.css": "body { margin: 0; }\n",
    "vite.config.ts": 'import prettyCode from "rehype-pretty-code";\n'
  });
  const stdout = vi.fn();

  expect(await runIntegrate(["--dry-run"], { cwd, version: "0.1.0-alpha.2", stdout })).toBe(0);
  const output = stdout.mock.calls.join("\n");
  expect(output).toMatch(/Warnings\n[\s\S]*existing syntax highlighter/u);
  expect(output).toContain("integrate will not remove or replace it");
  expect(output).not.toContain("init will not remove or replace it");
  expect(output.indexOf("Warnings")).toBeLessThan(output.indexOf("Manual steps"));
});

it("applies one style import and remains idempotent", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, vite: "8.1.3" } }),
    "src/index.css": "body { margin: 0; }\n"
  });
  const confirm = vi.fn(async () => true);
  const stdout = vi.fn();

  expect(await runIntegrate(["--mode", "foundation"], { cwd, version: "0.1.0-alpha.2", stdout, confirm })).toBe(0);
  expect(await runIntegrate(["--mode", "foundation", "--yes"], { cwd, version: "0.1.0-alpha.2", stdout: vi.fn() })).toBe(0);
  expect(confirm).toHaveBeenCalledWith("Apply this Scribe integration plan?");
  expect(stdout.mock.calls.join("\n")).toContain("npx --no-install scribe validate path/to/article.mdx");
  const css = await readFile(join(cwd, "src/index.css"), "utf8");
  expect(css.match(/@scribe-sdk\/styles\/foundation\.css/gu)).toHaveLength(1);
});

it("keeps the Scribe Tailwind layer after Tailwind v4's required import", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, tailwindcss: "4.3.3", "@tailwindcss/typography": "0.5.20", vite: "8.1.3" } }),
    "src/index.css": "@import \"tailwindcss\";\n@plugin \"@tailwindcss/typography\";\n"
  });

  expect(await runIntegrate(["--mode", "tailwind", "--yes"], { cwd, version: "0.1.0-alpha.2", stdout: vi.fn() })).toBe(0);
  expect(await readFile(join(cwd, "src/index.css"), "utf8")).toMatch(
    /^@import "tailwindcss";\n@import "@scribe-sdk\/styles\/tailwind\.css";\n/u
  );
});

it("creates but never duplicates an unambiguous Next component map", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, next: "16.2.11", "@next/mdx": "16.2.11" } }),
    "app/globals.css": "body { margin: 0; }\n",
    "next.config.mjs": "import createMDX from '@next/mdx';\nexport default createMDX({})({});\n"
  });

  expect(await runIntegrate(["--mode", "default", "--yes"], { cwd, version: "0.1.0-alpha.2", stdout: vi.fn() })).toBe(0);
  expect(await runIntegrate(["--mode", "default", "--yes"], { cwd, version: "0.1.0-alpha.2", stdout: vi.fn() })).toBe(0);
  const components = await readFile(join(cwd, "mdx-components.tsx"), "utf8");
  expect(components.match(/createScribeComponents/gu)).toHaveLength(2);
  expect(components.match(/export function useMDXComponents/gu)).toHaveLength(1);
});

it("names the next-mdx-remote/rsc options prop precisely", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, next: "16.2.11", "next-mdx-remote": "6.0.0" } }),
    "app/globals.css": "body { margin: 0; }\n",
    "app/page.tsx": 'import { MDXRemote } from "next-mdx-remote/rsc"; export default () => <MDXRemote source="# Article" />;'
  });

  const plan = await planIntegrate(cwd, "foundation", "0.1.0-alpha.2");
  expect(plan.manualSteps.join("\n")).toContain("existing MDXRemote options prop");
  expect(plan.manualSteps.join("\n")).not.toContain("compileOptions");
});

it("preserves CRLF files while adding the selected import", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, vite: "8.1.3" } }),
    "src/index.css": "body {\r\n  margin: 0;\r\n}\r\n"
  });

  expect(await runIntegrate(["--mode", "default", "--yes"], { cwd, version: "0.1.0-alpha.2", stdout: vi.fn() })).toBe(0);
  const css = await readFile(join(cwd, "src/index.css"), "utf8");
  expect(css).toContain('default.css";\r\n\r\nbody');
  expect(css.replaceAll("\r\n", "")).not.toContain("\n");
});

it("rolls back earlier file changes after a later write fails", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ private: true, dependencies: { react: "19.2.7", next: "16.2.11", "@next/mdx": "16.2.11" } }),
    "app/globals.css": "body { margin: 0; }\n",
    "next.config.mjs": "import createMDX from '@next/mdx';\nexport default createMDX({})({});\n"
  });
  const stderr = vi.fn();

  expect(await runIntegrate(["--mode", "default", "--yes"], {
    cwd,
    version: "0.1.0-alpha.2",
    stdout: vi.fn(),
    stderr,
    runCommand: async () => {
      await mkdir(join(cwd, "mdx-components.tsx"), { recursive: true });
      return 0;
    }
  })).toBe(1);
  expect(await readFile(join(cwd, "app/globals.css"), "utf8")).not.toContain("@scribe-sdk/styles/default.css");
  const error = stderr.mock.calls.join("\n");
  expect(error).toContain("Could not complete the Scribe integration");
  expect(error).toContain("Could not apply the reported Scribe change");
  expect(error).toContain("Rollback");
  expect((await readdir(cwd)).filter((name) => name.includes(".scribe-") && name.endsWith(".tmp"))).toEqual([]);
});

it("restores manifests and leaves source files untouched after an install command fails", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ private: true, dependencies: { react: "19.2.7", vite: "8.1.3" } }),
    "bun.lock": "",
    "src/index.css": "body { margin: 0; }\n"
  });
  const runCommand = vi.fn(async () => 1);
  const stderr = vi.fn();

  expect(await runIntegrate(["--mode", "default", "--yes"], { cwd, version: "0.1.0-alpha.2", stdout: vi.fn(), stderr, runCommand })).toBe(1);
  expect(runCommand).toHaveBeenCalledTimes(1);
  expect(await readFile(join(cwd, "src/index.css"), "utf8")).toBe("body { margin: 0; }\n");
  expect(stderr.mock.calls.join("\n")).toContain("Command failed with status 1");
  expect((await readdir(cwd)).filter((name) => name === ".scribe-integrate.lock")).toEqual([]);
});

it("cancels cleanly with a zero exit code when the plan is declined", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, vite: "8.1.3" } }),
    "src/index.css": "body { margin: 0; }\n"
  });
  const confirm = vi.fn(async () => false);
  const stdout = vi.fn();

  expect(await runIntegrate(["--mode", "default"], { cwd, version: "0.1.0-alpha.2", stdout, confirm })).toBe(0);
  expect(confirm).toHaveBeenCalledWith("Apply this Scribe integration plan?");
  expect(stdout.mock.calls.join("\n")).toContain("Cancelled");
  expect(await readFile(join(cwd, "src/index.css"), "utf8")).toBe("body { margin: 0; }\n");
  expect((await readdir(cwd)).filter((name) => name === ".scribe-integrate.lock")).toEqual([]);
});

it("refuses to apply without confirmation in a non-interactive terminal", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, vite: "8.1.3" } }),
    "src/index.css": "body { margin: 0; }\n"
  });
  const stderr = vi.fn();

  expect(await runIntegrate(["--mode", "default"], { cwd, version: "0.1.0-alpha.2", stderr })).toBe(2);
  expect(stderr.mock.calls.join("\n")).toContain("--yes");
  expect((await readdir(cwd)).filter((name) => name === ".scribe-integrate.lock")).toEqual([]);
});

it("installs missing packages transactionally with --yes and reports the bootstrap", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ private: true, dependencies: { react: "19.2.7", vite: "8.1.3" } }),
    "package-lock.json": "{}",
    "src/index.css": "body { margin: 0; }\n"
  });
  const installed: (readonly string[])[] = [];
  const runCommand = vi.fn(async (command: readonly string[]) => {
    installed.push(command);
    for (const spec of command.filter((value) => value.startsWith("@scribe-sdk/"))) {
      const version = spec.split("@").pop();
      const name = spec.slice(0, -(Number(version?.length) + 1));
      await mkdir(join(cwd, "node_modules", ...name.split("/")), { recursive: true });
      await writeFile(join(cwd, "node_modules", ...name.split("/"), "package.json"), JSON.stringify({ name, version }));
    }
    await writeFile(join(cwd, "node_modules", "@scribe-sdk", "styles", "default.css"), "");
    return 0;
  });
  const stdout = vi.fn();

  expect(await runIntegrate(["--mode", "default", "--yes"], { cwd, version: "0.1.0-alpha.8", stdout, runCommand })).toBe(0);
  expect(installed).toHaveLength(2);
  expect(installed[0]?.join(" ")).toBe("npm install @scribe-sdk/react@0.1.0-alpha.8 @scribe-sdk/styles@0.1.0-alpha.8 @scribe-sdk/mdx@0.1.0-alpha.8");
  expect(installed[1]?.join(" ")).toBe("npm install --save-dev @scribe-sdk/cli@0.1.0-alpha.8");
  expect(await readFile(join(cwd, "src/index.css"), "utf8")).toContain("@scribe-sdk/styles/default.css");
  const output = stdout.mock.calls.join("\n");
  expect(output).toContain("Success  Scribe integrated");
  expect(output).toContain("+ @scribe-sdk/cli@0.1.0-alpha.8 (dev)");
  expect(output).toContain("Scribe is installed in this project.");
  expect(output).toContain("npm install --global @scribe-sdk/cli@alpha");
});

it("reports copyable install commands for unsupported package managers", async () => {
  const pnpmCwd = await project({
    "package.json": JSON.stringify({ private: true, dependencies: { react: "19.2.7", vite: "8.1.3" } }),
    "pnpm-lock.yaml": "",
    "src/index.css": "body { margin: 0; }\n"
  });
  const pnpmPlan = await planIntegrate(pnpmCwd, "default", "0.1.0-alpha.8");
  expect(pnpmPlan.inspection.packageManager).toBe("pnpm");
  expect(pnpmPlan.commands).toEqual([]);
  expect(pnpmPlan.packages.map((entry) => entry.name)).toEqual(["@scribe-sdk/react", "@scribe-sdk/styles", "@scribe-sdk/mdx", "@scribe-sdk/cli"]);
  expect(pnpmPlan.warnings.join("\n")).toContain("not automated for pnpm");
  expect(pnpmPlan.manualSteps.join("\n")).toContain("pnpm add @scribe-sdk/react@0.1.0-alpha.8 @scribe-sdk/styles@0.1.0-alpha.8 @scribe-sdk/mdx@0.1.0-alpha.8");
  expect(pnpmPlan.manualSteps.join("\n")).toContain("pnpm add -D @scribe-sdk/cli@0.1.0-alpha.8");

  const yarnCwd = await project({
    "package.json": JSON.stringify({ private: true, dependencies: { react: "19.2.7", vite: "8.1.3" } }),
    "yarn.lock": "",
    "src/index.css": "body { margin: 0; }\n"
  });
  const yarnPlan = await planIntegrate(yarnCwd, "default", "0.1.0-alpha.8");
  expect(yarnPlan.inspection.packageManager).toBe("yarn");
  expect(yarnPlan.manualSteps.join("\n")).toContain("yarn add @scribe-sdk/react@0.1.0-alpha.8 @scribe-sdk/styles@0.1.0-alpha.8 @scribe-sdk/mdx@0.1.0-alpha.8");
  expect(yarnPlan.manualSteps.join("\n")).toContain("yarn add -D @scribe-sdk/cli@0.1.0-alpha.8");
  expect(yarnPlan.manualSteps.join("\n")).not.toContain("pnpm");
});

it("stops before changing files when packages are missing under a manual-only manager", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ private: true, dependencies: { react: "19.2.7", vite: "8.1.3" } }),
    "pnpm-lock.yaml": "",
    "src/index.css": "body { margin: 0; }\n"
  });
  const stderr = vi.fn();

  expect(await runIntegrate(["--mode", "default", "--yes"], { cwd, version: "0.1.0-alpha.8", stdout: vi.fn(), stderr })).toBe(2);
  expect(await readFile(join(cwd, "src/index.css"), "utf8")).toBe("body { margin: 0; }\n");
  expect((await readdir(cwd)).filter((name) => name === ".scribe-integrate.lock")).toEqual([]);
  const error = stderr.mock.calls.join("\n");
  expect(error).toContain("pnpm add @scribe-sdk/react@0.1.0-alpha.8 @scribe-sdk/styles@0.1.0-alpha.8 @scribe-sdk/mdx@0.1.0-alpha.8");
  expect(error).toContain("pnpm add -D @scribe-sdk/cli@0.1.0-alpha.8");
});

it("fails and rolls back when the selected stylesheet is missing on a no-command run", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, vite: "8.1.3" } }),
    "package-lock.json": "{}",
    "src/index.css": "body { margin: 0; }\n"
  });
  for (const name of ["react", "styles", "mdx", "cli"]) {
    await mkdir(join(cwd, "node_modules", "@scribe-sdk", name), { recursive: true });
    await writeFile(join(cwd, "node_modules", "@scribe-sdk", name, "package.json"), JSON.stringify({ name: `@scribe-sdk/${name}`, version: "0.1.0-alpha.8" }));
  }
  const stderr = vi.fn();

  expect(await runIntegrate(["--mode", "default", "--yes"], { cwd, version: "0.1.0-alpha.8", stdout: vi.fn(), stderr })).toBe(1);
  expect(await readFile(join(cwd, "src/index.css"), "utf8")).toBe("body { margin: 0; }\n");
  expect(stderr.mock.calls.join("\n")).toContain("default.css was not installed");
});

it("warns when installed Scribe package versions do not match the running CLI", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, vite: "8.1.3" } }),
    "package-lock.json": "{}",
    "src/index.css": "body { margin: 0; }\n"
  });
  for (const name of ["react", "styles", "mdx", "cli"]) {
    await mkdir(join(cwd, "node_modules", "@scribe-sdk", name), { recursive: true });
    await writeFile(join(cwd, "node_modules", "@scribe-sdk", name, "package.json"), JSON.stringify({ name: `@scribe-sdk/${name}`, version: "0.1.0-alpha.2" }));
  }

  const plan = await planIntegrate(cwd, undefined, "0.1.0-alpha.8");
  expect(plan.packages).toEqual([]);
  expect(plan.warnings.join("\n")).toContain("Scribe package versions do not match");
  expect(plan.warnings.join("\n")).toContain("npm install @scribe-sdk/react@0.1.0-alpha.8 @scribe-sdk/styles@0.1.0-alpha.8 @scribe-sdk/mdx@0.1.0-alpha.8");
  expect(plan.warnings.join("\n")).toContain("npm install --save-dev @scribe-sdk/cli@0.1.0-alpha.8");
});

it("rejects invalid options and unresolved projects with usage status", async () => {
  const cwd = await project({ "package.json": JSON.stringify({ dependencies: { react: "19.2.7" } }) });
  const stderr = vi.fn();
  expect(await runIntegrate(["--mode", "loud"], { cwd, version: "0.1.0-alpha.2", stderr })).toBe(2);
  expect(await runIntegrate(["--dryrun"], { cwd, version: "0.1.0-alpha.2", stderr })).toBe(2);
  expect(stderr.mock.calls.join("\n")).toContain('Did you mean "--dry-run"?');
  expect(await runIntegrate(["--dry-run"], { cwd, version: "0.1.0-alpha.2", stderr: vi.fn() })).toBe(2);
});

it("ignores a bun global-install cache inside the project when BUN_INSTALL points there", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, vite: "8.1.3" } }),
    "src/index.css": "body { margin: 0; }\n",
    "bun-global/install/cache/@scribe-sdk/react@0.1.0-alpha.8@@@1/README.md":
      "See createScribeComponents and createScribeMdxOptions for the full integration guide.\n"
  });
  const previous = process.env.BUN_INSTALL;
  process.env.BUN_INSTALL = join(cwd, "bun-global");
  try {
    const inspection = await inspectProject(cwd);
    expect(inspection.hasScribeComponents).toBe(false);
    expect(inspection.hasScribeCompiler).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.BUN_INSTALL;
    else process.env.BUN_INSTALL = previous;
  }
});

it("detects Scribe components from a bun global-install cache inside the project when BUN_INSTALL is unset", async () => {
  const cwd = await project({
    "package.json": JSON.stringify({ ...packages, dependencies: { ...packages.dependencies, vite: "8.1.3" } }),
    "src/index.css": "body { margin: 0; }\n",
    "bun-global/install/cache/@scribe-sdk/react@0.1.0-alpha.8@@@1/README.md":
      "See createScribeComponents for the full integration guide.\n"
  });
  const previous = process.env.BUN_INSTALL;
  delete process.env.BUN_INSTALL;
  try {
    const inspection = await inspectProject(cwd);
    expect(inspection.hasScribeComponents).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.BUN_INSTALL;
    else process.env.BUN_INSTALL = previous;
  }
});
