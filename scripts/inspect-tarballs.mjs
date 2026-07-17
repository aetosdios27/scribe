import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { readTarball } from "./lib/tarball.mjs";

const directory = resolve(process.argv[2] ?? ".scribe-release");
const packages = [
  { name: "@scribe-sdk/mdx", directory: "mdx", runtime: "dist/" },
  { name: "@scribe-sdk/react", directory: "react", runtime: "dist/" },
  { name: "@scribe-sdk/styles", directory: "styles", runtime: "default.css" },
  { name: "@scribe-sdk/cli", directory: "cli", runtime: "dist/index.mjs" }
];
const forbidden = /(^|\/)(src|tests?|fixtures?|screenshots?|playwright-report|coverage|\.changeset|\.env|\.git)(\/|$)|\.(png|snap|map)$/u;
const repositoryOnlyDocuments = new Set(["RELEASING.md", "RELEASE_NOTES.md", "CHANGELOG.md"]);
const summary = [];

for (const expected of packages) {
  const sourceManifest = JSON.parse(await readFile(join(process.cwd(), "packages", expected.directory, "package.json"), "utf8"));
  const version = sourceManifest.version;
  const file = `scribe-sdk-${expected.directory}-${version}.tgz`;
  const tarball = join(directory, file);
  const archiveEntries = readTarball(await readFile(tarball));
  const entries = archiveEntries.map((entry) => entry.path.replace(/^package\//u, ""));
  for (const required of ["package.json", "README.md", "SKILL.md", "LICENSE", expected.runtime]) {
    if (!entries.some((entry) => entry === required || entry.startsWith(required))) {
      throw new Error(`${file} is missing ${required}.`);
    }
  }
  const leaked = entries.filter(
    (entry) => forbidden.test(entry) || repositoryOnlyDocuments.has(entry)
  );
  if (leaked.length > 0) throw new Error(`${file} contains forbidden files: ${leaked.join(", ")}`);

  const manifestText = entryText(archiveEntries, "package/package.json", file);
  const manifest = JSON.parse(manifestText);
  if (manifest.name !== expected.name || manifest.version !== version || manifest.private === true) {
    throw new Error(`${file} has unexpected package identity.`);
  }
  if (/workspace:|file:|\/home\/|\\Users\\/u.test(manifestText)) {
    throw new Error(`${file} contains a workspace or filesystem reference.`);
  }
  const declarationEntries = entries.filter((entry) => entry.endsWith(".d.mts"));
  for (const entry of declarationEntries) {
    const declaration = entryText(archiveEntries, `package/${entry}`, file);
    if (/\/home\/|\\Users\\|node_modules\/\.bun|workspace:/u.test(declaration)) {
      throw new Error(`${file}:${entry} contains a local dependency path.`);
    }
  }

  const packed = await stat(tarball);
  const unpackedSize = archiveEntries.reduce((total, entry) => total + entry.size, 0);
  const topLevelFiles = [...new Set(entries.map((entry) => entry.split("/")[0]).filter(Boolean))].sort();
  summary.push({
    package: expected.name,
    version,
    filename: file,
    packedSize: packed.size,
    unpackedSize,
    topLevelFiles,
    sourceMaps: entries.filter((entry) => entry.endsWith(".map")),
    declarations: declarationEntries,
    files: entries
  });
}

const report = `${JSON.stringify(summary, null, 2)}\n`;
await writeFile(join(directory, "tarball-inspection.json"), report);
process.stdout.write(report);

function entryText(entries, path, file) {
  const entry = entries.find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`${file} is missing ${path}.`);
  return entry.content.toString("utf8");
}
