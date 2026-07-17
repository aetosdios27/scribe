import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const directory = resolve(process.argv[2] ?? ".scribe-release");
const packages = [
  { name: "@scribe/mdx", directory: "mdx", runtime: "dist/" },
  { name: "@scribe/react", directory: "react", runtime: "dist/" },
  { name: "@scribe/styles", directory: "styles", runtime: "default.css" },
  { name: "@scribe/cli", directory: "cli", runtime: "dist/index.mjs" }
];
const forbidden = /(^|\/)(src|tests?|fixtures?|screenshots?|playwright-report|coverage|\.changeset|\.env|\.git)(\/|$)|\.(png|snap|map)$/u;
const repositoryOnlyDocuments = new Set(["RELEASING.md", "RELEASE_NOTES.md", "CHANGELOG.md"]);
const summary = [];

for (const expected of packages) {
  const sourceManifest = JSON.parse(await readFile(join(process.cwd(), "packages", expected.directory, "package.json"), "utf8"));
  const version = sourceManifest.version;
  const file = `scribe-${expected.directory}-${version}.tgz`;
  const tarball = join(directory, file);
  const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((entry) => entry.replace(/^package\//u, ""));
  for (const required of ["package.json", "README.md", "SKILL.md", "LICENSE", expected.runtime]) {
    if (!entries.some((entry) => entry === required || entry.startsWith(required))) {
      throw new Error(`${file} is missing ${required}.`);
    }
  }
  const leaked = entries.filter(
    (entry) => forbidden.test(entry) || repositoryOnlyDocuments.has(entry)
  );
  if (leaked.length > 0) throw new Error(`${file} contains forbidden files: ${leaked.join(", ")}`);

  const manifestText = execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" });
  const manifest = JSON.parse(manifestText);
  if (manifest.name !== expected.name || manifest.version !== version || manifest.private === true) {
    throw new Error(`${file} has unexpected package identity.`);
  }
  if (/workspace:|file:|\/home\/|\\Users\\/u.test(manifestText)) {
    throw new Error(`${file} contains a workspace or filesystem reference.`);
  }
  const declarationEntries = entries.filter((entry) => entry.endsWith(".d.mts"));
  for (const entry of declarationEntries) {
    const declaration = execFileSync("tar", ["-xOzf", tarball, `package/${entry}`], { encoding: "utf8" });
    if (/\/home\/|\\Users\\|node_modules\/\.bun|workspace:/u.test(declaration)) {
      throw new Error(`${file}:${entry} contains a local dependency path.`);
    }
  }

  const packed = await stat(tarball);
  const verboseEntries = execFileSync("tar", ["-tvzf", tarball], { encoding: "utf8" }).trim().split("\n");
  const unpackedSize = verboseEntries.reduce((total, line) => {
    const match = /^\S+\s+\S+\s+(\d+)\s/u.exec(line);
    return total + Number(match?.[1] ?? 0);
  }, 0);
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

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
