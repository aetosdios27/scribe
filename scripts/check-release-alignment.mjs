import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicPackages = [
  { name: "@scribe-sdk/react", directory: "react" },
  { name: "@scribe-sdk/styles", directory: "styles" },
  { name: "@scribe-sdk/mdx", directory: "mdx" },
  { name: "@scribe-sdk/cli", directory: "cli" }
];
const nativePackages = [
  ["@scribe-sdk/cli-linux-x64-gnu", "linux-x64-gnu"],
  ["@scribe-sdk/cli-linux-x64-musl", "linux-x64-musl"],
  ["@scribe-sdk/cli-linux-arm64-gnu", "linux-arm64-gnu"],
  ["@scribe-sdk/cli-linux-arm64-musl", "linux-arm64-musl"],
  ["@scribe-sdk/cli-darwin-x64", "darwin-x64"],
  ["@scribe-sdk/cli-darwin-arm64", "darwin-arm64"],
  ["@scribe-sdk/cli-win32-x64-msvc", "win32-x64-msvc"],
  ["@scribe-sdk/cli-win32-arm64-msvc", "win32-arm64-msvc"]
];
const expectedNames = publicPackages.map(({ name }) => name);
const manifests = await Promise.all(publicPackages.map(async ({ directory }) =>
  JSON.parse(await readFile(join(root, "packages", directory, "package.json"), "utf8"))
));
const versions = new Set(manifests.map(({ version }) => version));

assert(versions.size === 1, `Public package versions drifted: ${formatVersions(manifests)}.`);
const [version] = versions;
assert(typeof version === "string", "Public packages must declare a version.");

for (const manifest of manifests) {
  assert(manifest.private !== true, `${manifest.name} is unexpectedly private.`);
  assert(manifest.license === "Apache-2.0", `${manifest.name} must use Apache-2.0.`);
  assert(!JSON.stringify(manifest).includes("workspace:"), `${manifest.name} contains a workspace protocol.`);
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
      if (expectedNames.includes(dependency)) {
        assert(range === version, `${manifest.name} has ${dependency}@${range}; expected ${version}.`);
      }
    }
  }
}

const cliManifest = manifests.find(({ name }) => name === "@scribe-sdk/cli");
assert(
  cliManifest?.bin?.scribe === "./dist/bootstrap.mjs" && cliManifest.bin.scb === "./dist/bootstrap.mjs",
  "@scribe-sdk/cli must expose scribe and the scb compatibility alias from the native bootstrap."
);
const nativeManifests = await Promise.all(nativePackages.map(async ([name, directory]) => {
  const manifest = JSON.parse(await readFile(join(root, "packages", "cli-native", directory, "package.json"), "utf8"));
  assert(manifest.name === name, `Expected ${name} in packages/cli-native/${directory}.`);
  assert(manifest.version === version, `${name}@${String(manifest.version)} does not match ${version}.`);
  assert(cliManifest.optionalDependencies?.[name] === version, `@scribe-sdk/cli must pin ${name}@${version}.`);
  return manifest;
}));
assert(nativeManifests.length === nativePackages.length, "Every native package manifest must be present.");

const config = JSON.parse(await readFile(join(root, ".changeset", "config.json"), "utf8"));
assert(config.access === "public", "Changesets access must be public.");
assert(config.baseBranch === "main", "Changesets baseBranch must be main.");
assert(config.fixed.length === 1, "Changesets must contain exactly one fixed group.");
assert(equalSets(config.fixed[0], expectedNames), `Changesets fixed group must contain exactly: ${expectedNames.join(", ")}.`);

const pre = JSON.parse(await readFile(join(root, ".changeset", "pre.json"), "utf8"));
assert(pre.mode === "pre", "The current release state must remain in prerelease mode.");
assert(pre.tag === "alpha" || pre.tag === "beta", `Unsupported prerelease channel: ${String(pre.tag)}.`);
assert(
  pre.initialVersions !== null &&
    typeof pre.initialVersions === "object" &&
    expectedNames.every((name) => typeof pre.initialVersions[name] === "string"),
  `Prerelease initial versions must be strings for: ${expectedNames.join(", ")}.`
);
const initialVersions = new Set(expectedNames.map((name) => pre.initialVersions[name]));
assert(initialVersions.size === 1, `Prerelease initial versions drifted: ${expectedNames.map((name) => `${name}@${String(pre.initialVersions[name])}`).join(", ")}.`);
const currentPrerelease = parsePrereleaseVersion(version);
assert(currentPrerelease.channel === pre.tag, `Current ${version} does not use the configured ${pre.tag} prerelease channel.`);

const bootstrapSource = await readFile(join(root, "packages", "cli", "src", "bootstrap.ts"), "utf8");
const engineSource = await readFile(join(root, "packages", "cli", "src", "engine.ts"), "utf8");
const compact = (source) => source.replace(/\s+/gu, "");
assert(
  compact(bootstrapSource).includes(compact('readFile(resolve(packageRoot, "package.json")')) &&
    compact(engineSource).includes("readPackageVersion()"),
  "The bootstrap and engine versions must come from the CLI package manifest."
);
for (const source of [bootstrapSource, engineSource]) {
  assert(!/export const version\s*=\s*["'][^"']+["']/u.test(source), "The CLI version must not be hard-coded.");
}
const cargoManifest = await readFile(join(root, "Cargo.toml"), "utf8");
const rustVersion = /^\s*version\s*=\s*"([^"]+)"/mu.exec(cargoManifest)?.[1];
assert(rustVersion === version, `Rust CLI version ${String(rustVersion)} does not match ${version}.`);

for (const filename of ["README.md", "SKILL.md"]) {
  const content = await readFile(join(root, filename), "utf8");
  const referencedVersions = [...content.matchAll(/@scribe-sdk\/(?:react|styles|mdx|cli)@([0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.-]+)/gu)]
    .map((match) => match[1]);
  const conflicting = referencedVersions.filter((referenced) => referenced !== version);
  assert(conflicting.length === 0, `${filename} references a conflicting Scribe version: ${[...new Set(conflicting)].join(", ")}.`);
  const retiredScope = ["@scribe", "/"].join("");
  assert(!content.includes(retiredScope), `${filename} references the retired ${retiredScope.slice(0, -1)} package scope.`);
}

process.stdout.write(`Release alignment verified for ${expectedNames.join(", ")} at ${version} in ${pre.tag} prerelease mode.\n`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function equalSets(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value) => right.includes(value));
}

function formatVersions(packages) {
  return packages.map(({ name, version: packageVersion }) => `${name}@${packageVersion}`).join(", ");
}

function parsePrereleaseVersion(value) {
  const match = /^(\d+\.\d+\.\d+)-([0-9A-Za-z-]+)(?:\.([0-9A-Za-z.-]+))?$/u.exec(String(value));
  assert(match !== null, `Expected a prerelease version, received ${String(value)}.`);
  return { base: match[1], channel: match[2], sequence: match[3] };
}
