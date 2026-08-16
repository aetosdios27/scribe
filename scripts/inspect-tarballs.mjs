import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { readTarball } from "./lib/tarball.mjs";

const directory = resolve(process.argv[2] ?? ".scribe-release");
const packages = [
  { name: "@scribe-sdk/mdx", directory: "mdx", runtime: "dist/" },
  { name: "@scribe-sdk/react", directory: "react", runtime: "dist/" },
  { name: "@scribe-sdk/styles", directory: "styles", runtime: "default.css" },
  { name: "@scribe-sdk/cli", directory: "cli", runtime: "dist/bootstrap.mjs" }
];
const nativeRuntimes = [
  ["linux-x64-gnu", "scribe-cli"],
  ["linux-x64-musl", "scribe-cli"],
  ["linux-arm64-gnu", "scribe-cli"],
  ["linux-arm64-musl", "scribe-cli"],
  ["darwin-x64", "scribe-cli"],
  ["darwin-arm64", "scribe-cli"],
  ["win32-x64-msvc", "scribe-cli.exe"],
  ["win32-arm64-msvc", "scribe-cli.exe"]
];
const forbidden = /(^|\/)(src|tests?|fixtures?|screenshots?|playwright-report|coverage|\.changeset|\.env|\.git)(\/|$)|\.(png|snap|map)$/u;
const repositoryOnlyDocuments = new Set(["RELEASING.md", "RELEASE_NOTES.md", "CHANGELOG.md"]);
const summary = [];

for (const expected of packages) {
  const sourceManifest = JSON.parse(await readFile(join(process.cwd(), "packages", expected.directory, "package.json"), "utf8"));
  const version = sourceManifest.version;
  const artifactName = sourceManifest.name.replace(/^@/u, "").replaceAll("/", "-");
  const file = `${artifactName}-${version}.tgz`;
  const archiveEntries = readTarball(await readFile(join(directory, file)));
  const entries = archiveEntries.map((entry) => entry.path.replace(/^package\//u, ""));
  const requiredEntries = ["package.json", "README.md", "SKILL.md", "LICENSE", expected.runtime];
  for (const required of requiredEntries) {
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
  if (expected.directory === "cli") {
    const expectedBins = { scribe: "./dist/bootstrap.mjs", scb: "./dist/bootstrap.mjs" };
    if (JSON.stringify(manifest.bin) !== JSON.stringify(expectedBins)) {
      throw new Error(`${file} must expose the scribe binary and scb compatibility alias from dist/bootstrap.mjs.`);
    }
    const executable = archiveEntries.find((entry) => entry.path === "package/dist/bootstrap.mjs");
    if (!executable || (executable.mode & 0o111) === 0) {
      throw new Error(`${file}:dist/bootstrap.mjs is not executable.`);
    }

    for (const [nativeDirectory, binary] of nativeRuntimes) {
      const binaryPath = `native/${nativeDirectory}/${binary}`;
      if (!entries.includes(binaryPath)) throw new Error(`${file} is missing bundled binary ${binaryPath}.`);
      const binaryEntry = archiveEntries.find((entry) => entry.path === `package/${binaryPath}`);
      if (!binaryEntry || (!binaryPath.endsWith(".exe") && (binaryEntry.mode & 0o111) === 0)) {
        throw new Error(`${file}:${binaryPath} is not executable.`);
      }
      const metadataPath = `native/${nativeDirectory}/build-metadata.json`;
      if (!entries.includes(metadataPath)) throw new Error(`${file} is missing ${metadataPath}.`);
      const metadata = JSON.parse(entryText(archiveEntries, `package/${metadataPath}`, file));
      if (metadata.package !== manifest.name || metadata.version !== manifest.version) {
        throw new Error(`${file} contains mismatched native build metadata for ${nativeDirectory}.`);
      }
      const digest = createHash("sha256").update(binaryEntry.content).digest("hex");
      if (metadata.sha256 !== digest) throw new Error(`${file}:${binaryPath} has a mismatched digest.`);
    }
  }
  const declarationEntries = entries.filter((entry) => entry.endsWith(".d.mts"));
  for (const entry of declarationEntries) {
    const declaration = entryText(archiveEntries, `package/${entry}`, file);
    if (/\/home\/|\\Users\\|node_modules\/\.bun|workspace:/u.test(declaration)) {
      throw new Error(`${file}:${entry} contains a local dependency path.`);
    }
  }

  const packed = await stat(join(directory, file));
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
    bin: manifest.bin,
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
