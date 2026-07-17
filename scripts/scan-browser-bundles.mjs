import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const targets = [
  "tests/integration/vite/dist",
  "tests/integration/next/.next/static",
  ".scribe-release/consumers/bun-vite/dist",
  ".scribe-release/consumers/npm-next/.next/static"
];
const runtimePattern = /@shikijs|shiki\/(?:core|langs|themes|engine)|vscode-textmate|oniguruma|createHighlighter|codeToHast|bundledLanguages|@mdx-js\/mdx|(?:^|["'])unified(?:["'/])|(?:^|["'])remark-(?:parse|gfm|rehype)|(?:^|["'])rehype-(?:slug|recma)|node:(?:fs|path|url|module)/u;
const assetPattern = /\.(?:wasm|tmLanguage|tmLanguage\.json)$/u;
const findings = [];
const copyChunks = [];

for (const target of targets) {
  for (const path of await files(join(root, target))) {
    const name = relative(root, path);
    if (assetPattern.test(path)) findings.push(`${name}: forbidden runtime asset`);
    if (![".js", ".mjs", ".cjs", ".css", ".html"].includes(extname(path))) continue;
    const content = await readFile(path, "utf8");
    const match = runtimePattern.exec(content);
    if (match) findings.push(`${name}: ${match[0]}`);
    if (content.includes("Code copied to clipboard.")) {
      copyChunks.push({ file: name, bytes: (await stat(path)).size });
    }
  }
}

if (findings.length > 0) {
  throw new Error(`Browser runtime leaks detected:\n${findings.join("\n")}`);
}

process.stdout.write(`${JSON.stringify({ searched: targets, runtimeLeaks: [], hydratedCopyChunks: copyChunks }, null, 2)}\n`);

async function files(directory) {
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return found;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await files(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}
