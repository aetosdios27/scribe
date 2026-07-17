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

const config = JSON.parse(await readFile(join(root, ".changeset", "config.json"), "utf8"));
assert(config.access === "public", "Changesets access must be public.");
assert(config.baseBranch === "main", "Changesets baseBranch must be main.");
assert(config.fixed.length === 1, "Changesets must contain exactly one fixed group.");
assert(equalSets(config.fixed[0], expectedNames), `Changesets fixed group must contain exactly: ${expectedNames.join(", ")}.`);

const pre = JSON.parse(await readFile(join(root, ".changeset", "pre.json"), "utf8"));
assert(pre.mode === "pre" && pre.tag === "alpha", "The current prerelease state must be alpha pre mode.");
const initialVersions = new Set(expectedNames.map((name) => pre.initialVersions[name]));
assert(initialVersions.size === 1, `Alpha initial versions drifted: ${expectedNames.map((name) => `${name}@${String(pre.initialVersions[name])}`).join(", ")}.`);
const [initialVersion] = initialVersions;
const currentAlpha = parseAlphaVersion(version);
const initialAlpha = parseAlphaVersion(initialVersion);
assert(currentAlpha.base === initialAlpha.base, `Current ${version} and alpha baseline ${initialVersion} use different semver bases.`);
assert(currentAlpha.sequence >= initialAlpha.sequence, `Current ${version} precedes alpha baseline ${initialVersion}.`);

const cliSource = await readFile(join(root, "packages", "cli", "src", "index.ts"), "utf8");
assert(!/export const version\s*=\s*["'][^"']+["']/u.test(cliSource), "The CLI version must come from its package manifest, not a hard-coded string.");

for (const filename of ["README.md", "SKILL.md"]) {
  const content = await readFile(join(root, filename), "utf8");
  const referencedVersions = [...content.matchAll(/@scribe-sdk\/(?:react|styles|mdx|cli)@([0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.-]+)/gu)]
    .map((match) => match[1]);
  const conflicting = referencedVersions.filter((referenced) => referenced !== version);
  assert(conflicting.length === 0, `${filename} references a conflicting Scribe version: ${[...new Set(conflicting)].join(", ")}.`);
  const retiredScope = ["@scribe", "/"].join("");
  assert(!content.includes(retiredScope), `${filename} references the retired ${retiredScope.slice(0, -1)} package scope.`);
}

process.stdout.write(`Release alignment verified for ${expectedNames.join(", ")} at ${version} in alpha prerelease mode.\n`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function equalSets(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value) => right.includes(value));
}

function formatVersions(packages) {
  return packages.map(({ name, version: packageVersion }) => `${name}@${packageVersion}`).join(", ");
}

function parseAlphaVersion(value) {
  const match = /^(\d+\.\d+\.\d+)-alpha\.(\d+)$/u.exec(String(value));
  assert(match !== null, `Expected an alpha prerelease version, received ${String(value)}.`);
  return { base: match[1], sequence: Number(match[2]) };
}
