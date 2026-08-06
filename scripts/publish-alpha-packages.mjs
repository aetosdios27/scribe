import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { spawnPortableSync } from "./lib/spawn.mjs";

export const publicPackages = [
  { name: "@scribe-sdk/styles", directory: "styles" },
  { name: "@scribe-sdk/react", directory: "react" },
  { name: "@scribe-sdk/mdx", directory: "mdx" },
  { name: "@scribe-sdk/cli", directory: "cli" }
];

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function publishAlphaPackages({
  root = defaultRoot,
  registry = npmRegistry,
  distTagAttempts = 12,
  distTagDelayMs = 500
} = {}) {
  assert(
    Number.isInteger(distTagAttempts) && distTagAttempts > 0,
    `distTagAttempts must be a positive integer; received ${String(distTagAttempts)}.`
  );
  assert(
    Number.isFinite(distTagDelayMs) && distTagDelayMs >= 0,
    `distTagDelayMs must be finite and non-negative; received ${String(distTagDelayMs)}.`
  );

  const pre = await readJson(join(root, ".changeset", "pre.json"));
  assert(
    pre.mode === "pre" && pre.tag === "alpha",
    "Package publication requires Changesets alpha prerelease mode."
  );

  const releases = await Promise.all(publicPackages.map(async ({ name, directory }) => {
    const manifest = await readJson(join(root, "packages", directory, "package.json"));
    assert(manifest.name === name, `Expected ${name} in packages/${directory}/package.json.`);
    assert(
      /^\d+\.\d+\.\d+-alpha\.\d+$/u.test(manifest.version),
      `${name}@${String(manifest.version)} is not an alpha prerelease.`
    );
    return {
      name,
      version: manifest.version,
      tarball: join(root, ".scribe-release", `scribe-sdk-${directory}-${manifest.version}.tgz`)
    };
  }));

  const versions = new Set(releases.map(({ version }) => version));
  assert(versions.size === 1, `Public package versions are not synchronized: ${[...versions].join(", ")}.`);
  const [version] = versions;
  const tagsBefore = new Map();

  for (const { name } of releases) tagsBefore.set(name, await registry.distTags(name));

  for (const release of releases) {
    const publishedVersions = await registry.versions(release.name);
    if (publishedVersions.includes(release.version)) {
      process.stdout.write(`Skipping ${release.name}@${release.version}; it is already published.\n`);
      continue;
    }

    await access(release.tarball);
    process.stdout.write(`Publishing ${release.name}@${release.version} with the alpha dist-tag.\n`);
    await registry.publishTarball(release.name, release.tarball, "alpha");
    await assertPublishedAtAlpha(registry, release.name, version, tagsBefore.get(release.name)?.latest, {
      attempts: distTagAttempts,
      delayMs: distTagDelayMs
    });
  }

  process.stdout.write(`Verified all public packages at alpha=${version}; latest was unchanged.\n`);
}

const npmRegistry = {
  async versions(name) {
    const value = runNpmJson(["view", name, "versions", "--json"]);
    return Array.isArray(value) ? value : [value];
  },
  async distTags(name) {
    return runNpmJson(["view", name, "dist-tags", "--json"]);
  },
  async publishTarball(_name, tarball, tag) {
    runNpm(["publish", tarball, "--tag", tag, "--access", "public"], "inherit");
  }
};

async function assertPublishedAtAlpha(registry, name, expected, latestBefore, { attempts, delayMs }) {
  const latestOk = (tags) => tags.latest === latestBefore;
  const alphaOk = (tags) => tags.alpha === expected;
  let tags = {};

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    tags = await registry.distTags(name);
    if (latestOk(tags)) {
      if (alphaOk(tags)) return;
      if (attempt < attempts) {
        process.stdout.write(
          `Waiting for ${name} dist-tag alpha to converge to ${expected} (attempt ${attempt}/${attempts}).\n`
        );
        await sleep(delayMs);
      }
      continue;
    }
    throw new Error(
      `${name} changed latest from ${String(latestBefore)} to ${String(tags.latest)}.`
    );
  }

  throw new Error(`${name} has alpha=${String(tags.alpha)}; expected ${expected}.`);
}

function runNpmJson(args) {
  const output = runNpm(args, "pipe");
  return JSON.parse(output);
}

function runNpm(args, stdio) {
  const result = spawnPortableSync("npm", args, {
    cwd: defaultRoot,
    encoding: "utf8",
    stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "inherit"]
  });
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} exited with code ${String(result.status)}.`);
  return result.stdout ?? "";
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function isDirectExecution(moduleUrl, entryPath, cwd = process.cwd()) {
  return Boolean(entryPath) && fileURLToPath(moduleUrl) === resolve(cwd, entryPath);
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  await publishAlphaPackages();
}
