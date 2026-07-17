import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const reportDirectory = join(root, ".scribe-release");
const textExtensions = new Set([".cjs", ".css", ".cts", ".html", ".js", ".json", ".lock", ".md", ".mdx", ".mjs", ".mts", ".sh", ".svg", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml"]);
const textNames = new Set([".gitignore", ".npmrc", "Dockerfile", "LICENSE", "SKILL.md"]);
const oldScope = ["@scribe", "/"].join("");
const maintainerHome = ["/home", "/aetos"].join("");
const fixedTemp = ["/tmp", "/"].join("");
const heliumExecutable = ["/usr/bin", "/helium"].join("");
const heliumAdapter = "scripts/run-helium-visual.mjs";
const findings = [];

const files = await repositoryFiles(root);

for (const file of files) {
  if (!textExtensions.has(extname(file)) && !textNames.has(file.split(/[\\/]/u).at(-1))) continue;
  let content;
  try {
    content = await readFile(join(root, file), "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") continue;
    throw error;
  }

  for (const forbidden of [oldScope, maintainerHome, fixedTemp]) {
    if (content.includes(forbidden)) findings.push({ file, value: forbidden });
  }
  if (content.includes(heliumExecutable) && file !== heliumAdapter) {
    findings.push({ file, value: heliumExecutable });
  }
  if (file.startsWith("packages/") && /helium/iu.test(content)) {
    findings.push({ file, value: "Helium runtime/package reference" });
  }
}

const report = {
  scannedFiles: files.length,
  allowed: { [heliumExecutable]: heliumAdapter },
  findings
};
await mkdir(reportDirectory, { recursive: true });
await writeFile(join(reportDirectory, "portability-scan.json"), `${JSON.stringify(report, null, 2)}\n`);

if (findings.length > 0) {
  throw new Error(`Portability scan failed:\n${findings.map(({ file, value }) => `${file}: ${value}`).join("\n")}`);
}

process.stdout.write(`Portability scan passed across ${files.length} repository files.\n`);

async function repositoryFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", ".next", ".scribe-pack", ".scribe-release", "coverage", "dist", "node_modules", "out", "playwright-report", "test-results"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await repositoryFiles(path));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files;
}
