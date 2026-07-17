import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = process.cwd();
const release = join(root, ".scribe-release");
const consumers = join(release, "consumers");
const version = JSON.parse(await readFile(join(root, "packages", "react", "package.json"), "utf8")).version;
const tarballs = {
  mdx: `../../scribe-mdx-${version}.tgz`,
  react: `../../scribe-react-${version}.tgz`,
  styles: `../../scribe-styles-${version}.tgz`,
  cli: `../../scribe-cli-${version}.tgz`
};
const results = [];

await rm(consumers, { recursive: true, force: true });
await mkdir(consumers, { recursive: true });
await createViteConsumer();
await createNextConsumer();

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);

async function createViteConsumer() {
  const directory = join(consumers, "bun-vite");
  await mkdir(join(directory, "src"), { recursive: true });
  await write(directory, "package.json", JSON.stringify({
    name: "scribe-packed-bun-vite",
    private: true,
    type: "module",
    scripts: {
      build: "vite build",
      typecheck: "node ./node_modules/@typescript/native/bin/tsc --noEmit"
    },
    dependencies: {
      "@mdx-js/rollup": "3.1.1",
      "@scribe/cli": `file:${tarballs.cli}`,
      "@scribe/mdx": `file:${tarballs.mdx}`,
      "@scribe/react": `file:${tarballs.react}`,
      "@scribe/styles": `file:${tarballs.styles}`,
      "@vitejs/plugin-react": "6.0.3",
      react: "19.2.7",
      "react-dom": "19.2.7",
      vite: "8.1.3"
    },
    overrides: {
      "@scribe/mdx": `file:${tarballs.mdx}`
    },
    devDependencies: {
      "@typescript/native": "npm:typescript@7.0.2",
      "@types/react": "19.2.17",
      "@types/react-dom": "19.2.3"
    }
  }, null, 2));
  await write(directory, "index.html", '<div id="root"></div><script type="module" src="/src/main.tsx"></script>\n');
  await write(directory, "tsconfig.json", tsconfig());
  await write(directory, "src/mdx.d.ts", 'declare module "*.mdx" { const Component: (props: { components?: Record<string, unknown> }) => import("react").ReactNode; export default Component; }\n');
  await write(directory, "src/mdx-options.ts", 'import { createScribeMdxOptions } from "@scribe/mdx"; const options = createScribeMdxOptions(); export const pluginCount = options.remarkPlugins.length + options.rehypePlugins.length;\n');
  await write(directory, "vite.config.ts", `import mdx from "@mdx-js/rollup";
import { createScribeMdxOptions } from "@scribe/mdx";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({ plugins: [{ ...mdx(createScribeMdxOptions()), enforce: "pre" }, react({ include: /\\.(?:js|jsx|md|mdx|ts|tsx)$/ })] });
`);
  await write(directory, "src/main.tsx", `import { createRoot } from "react-dom/client";
import { createScribeComponents } from "@scribe/react";
import "@scribe/styles/default.css";
import Article from "./article.mdx";
const root = document.querySelector("#root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<Article components={createScribeComponents()} />);
`);
  await write(directory, "src/article.mdx", article());
  await write(directory, "src/invalid.mdx", '<Callout variant="warnng">Typo</Callout>\n');

  run("bun", ["install"], directory);
  run("bun", ["install", "--frozen-lockfile"], directory);
  run("bun", ["run", "typecheck"], directory);
  run("bun", ["run", "build"], directory);
  run("node", ["--input-type=module", "-e", "import('@scribe/react').then((api) => { const expected = ['Banner','Callout','CodeFrame','Figure','Publication','ScribeImage','createScribeComponents']; if (JSON.stringify(Object.keys(api).sort()) !== JSON.stringify(expected)) process.exit(1) })"], directory);
  run("node", ["--input-type=module", "-e", "import('@scribe/react/components').then(() => process.exit(1)).catch((error) => { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') process.exit(1) })"], directory);
  await assertPackagedSkill(directory);
  const cliVersion = run(bin(directory, "scb"), ["--version"], directory);
  if (cliVersion.stdout.trim() !== version) throw new Error(`Bun Vite CLI reported ${cliVersion.stdout.trim()}, expected ${version}.`);
  run(bin(directory, "scb"), ["--help"], directory);
  run(bin(directory, "scb"), ["validate", join(directory, "src/article.mdx")], directory);
  const invalid = run(bin(directory, "scb"), ["validate", join(directory, "src/invalid.mdx")], directory, false);
  if (invalid.status !== 1 || !invalid.stderr.includes("SCB1101")) throw new Error("Bun Vite invalid fixture did not produce SCB1101.");
}

async function createNextConsumer() {
  const directory = join(consumers, "npm-next");
  await mkdir(join(directory, "app"), { recursive: true });
  await write(directory, "package.json", JSON.stringify({
    name: "scribe-packed-npm-next",
    private: true,
    type: "module",
    scripts: { build: "next build", typecheck: "tsc --noEmit" },
    dependencies: {
      "@mdx-js/loader": "3.1.1",
      "@mdx-js/react": "3.1.1",
      "@next/mdx": "16.2.10",
      "@scribe/cli": `file:${tarballs.cli}`,
      "@scribe/mdx": `file:${tarballs.mdx}`,
      "@scribe/react": `file:${tarballs.react}`,
      "@scribe/styles": `file:${tarballs.styles}`,
      next: "16.2.10",
      react: "19.2.7",
      "react-dom": "19.2.7"
    },
    devDependencies: {
      "@types/node": "22.20.1",
      "@types/react": "19.2.17",
      "@types/react-dom": "19.2.3",
      typescript: "6.0.2"
    }
  }, null, 2));
  await write(directory, "tsconfig.json", JSON.stringify({
    compilerOptions: {
      target: "ES2022", lib: ["DOM", "DOM.Iterable", "ES2024"], strict: true, skipLibCheck: false,
      noEmit: true, module: "ESNext", moduleResolution: "Bundler", jsx: "preserve",
      isolatedModules: true, esModuleInterop: true, plugins: [{ name: "next" }],
      types: ["node", "react", "react-dom"]
    },
    include: ["**/*.ts", "**/*.tsx", "**/*.mdx", ".next/types/**/*.ts"]
  }, null, 2));
  await write(directory, "next-env.d.ts", '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n');
  await write(directory, "mdx.d.ts", 'declare module "*.mdx" { const Component: (props: { components?: Record<string, unknown> }) => import("react").ReactNode; export default Component; }\n');
  await write(directory, "next.config.mjs", `import createMDX from "@next/mdx";
import { createScribeNextMdxOptions } from "@scribe/mdx/next";
import { fileURLToPath } from "node:url";
const withMDX = createMDX({ options: createScribeNextMdxOptions() });
export default withMDX({ output: "export", pageExtensions: ["js", "jsx", "md", "mdx", "ts", "tsx"], turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) } });
`);
  await write(directory, "mdx-components.tsx", `import { createScribeComponents } from "@scribe/react";
import type { ScribeComponents } from "@scribe/react";
export function useMDXComponents(components: ScribeComponents): ScribeComponents { return createScribeComponents({ components }); }
`);
  await write(directory, "app/layout.tsx", `import type { ReactNode } from "react";
import "@scribe/styles/default.css";
export default function Layout({ children }: { children: ReactNode }) { return <html lang="en"><body>{children}</body></html>; }
`);
  await write(directory, "app/page.tsx", 'import Article from "./article.mdx"; export default function Page() { return <Article />; }\n');
  await write(directory, "app/article.mdx", article());
  await write(directory, "invalid.mdx", '<Callout variant="warnng">Typo</Callout>\n');

  await runStreaming("npm", ["install", "--cache", "/tmp/scribe-npm-cache", "--prefer-offline", "--no-audit", "--no-fund"], directory);
  run("npm", ["run", "typecheck"], directory);
  run("npm", ["run", "build"], directory);
  run("node", ["--input-type=module", "-e", "import('@scribe/cli/dist/index.mjs').then(() => process.exit(1)).catch((error) => { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') process.exit(1) })"], directory);
  await assertPackagedSkill(directory);
  const cliVersion = run(bin(directory, "scb"), ["--version"], directory);
  if (cliVersion.stdout.trim() !== version) throw new Error(`npm Next CLI reported ${cliVersion.stdout.trim()}, expected ${version}.`);
  run(bin(directory, "scb"), ["--help"], directory);
  run(bin(directory, "scb"), ["validate", join(directory, "app/article.mdx")], directory);
  const invalid = run(bin(directory, "scb"), ["validate", join(directory, "invalid.mdx")], directory, false);
  if (invalid.status !== 1 || !invalid.stderr.includes("SCB1101")) throw new Error("npm Next invalid fixture did not produce SCB1101.");
}

function run(command, args, cwd, requireSuccess = true) {
  const label = `${command} ${args.join(" ")}`;
  process.stderr.write(`→ ${label}\n`);
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" } });
  results.push({ command: [command, ...args].join(" "), cwd, status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
  if (requireSuccess && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}:\n${result.stdout}\n${result.stderr}`);
  }
  process.stderr.write(`✓ ${label}\n`);
  return result;
}

async function runStreaming(command, args, cwd) {
  const label = `${command} ${args.join(" ")}`;
  process.stderr.write(`→ ${label}\n`);
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const heartbeat = setInterval(() => process.stderr.write(`… ${label}\n`), 5_000);
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => clearInterval(heartbeat));
  results.push({ command: label, cwd, status, stdout: stdout.trim(), stderr: stderr.trim() });
  if (status !== 0) throw new Error(`${label} failed in ${cwd}:\n${stdout}\n${stderr}`);
  process.stderr.write(`✓ ${label}\n`);
}

function bin(directory, name) {
  return join(directory, "node_modules", ".bin", name);
}

async function write(directory, relativePath, content) {
  const path = join(directory, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function assertPackagedSkill(directory) {
  for (const name of ["mdx", "react", "styles", "cli"]) {
    const packageDirectory = join(directory, "node_modules", "@scribe", name);
    const skill = await readFile(join(packageDirectory, "SKILL.md"), "utf8");
    if (!skill.includes("Treat unexpected integration workarounds as possible Scribe defects.")) {
      throw new Error(`@scribe/${name} did not install the canonical SKILL.md.`);
    }
    const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
    if (manifest.version !== version) throw new Error(`@scribe/${name} installed at ${manifest.version}, expected ${version}.`);
  }
}

function tsconfig() {
  return JSON.stringify({
    compilerOptions: {
      target: "ES2022", lib: ["DOM", "ES2022"], strict: true, skipLibCheck: false,
      noEmit: true, module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx",
      isolatedModules: true, types: ["vite/client"]
    },
    include: ["src"]
  }, null, 2);
}

function article() {
  return `<Banner title="Packed consumer" description="A real tarball integration." />

# Packed article

| State | Meaning |
| --- | --- |
| \`ready\` | Packages resolve outside the workspace. |

\`\`\`ts filename="src/state.ts" lineNumbers highlight="1"
export const state = "ready"
\`\`\`
`;
}
