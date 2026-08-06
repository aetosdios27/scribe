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

  for (const release of releases) {
    const publishedVersions = await registry.versions(release.name);
    const isFresh = !publishedVersions.includes(release.version);

    if (isFresh) {
      await access(release.tarball);
      process.stdout.write(`Publishing ${release.name}@${release.version} with the alpha dist-tag.\n`);
      await registry.publishTarball(release.name, release.tarball, "alpha");
    } else {
      process.stdout.write(`Skipping ${release.name}@${release.version}; it is already published.\n`);
    }

    await assertTagConverged(registry, release.name, "alpha", version, { attempts: distTagAttempts, delayMs: distTagDelayMs });
    process.stdout.write(`Pointing ${release.name} latest=${version}.\n`);
    await registry.setDistTag(release.name, version, "latest");
    await assertTagConverged(registry, release.name, "latest", version, { attempts: distTagAttempts, delayMs: distTagDelayMs });
  }

  process.stdout.write(`Verified all public packages at alpha=${version} and latest=${version}.\n`);
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
  },
  async setDistTag(name, version, tag) {
    runNpm(["dist-tag", "add", `${name}@${version}`, tag], "inherit");
  }
};

async function assertTagConverged(registry, name, tag, expected, { attempts, delayMs }) {
  let tags = {};

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    tags = await registry.distTags(name);
    if (tags[tag] === expected) return;
    if (attempt < attempts) {
      process.stdout.write(
        `Waiting for ${name} dist-tag ${tag} to converge to ${expected} (attempt ${attempt}/${attempts}).\n`
      );
      await sleep(delayMs);
    }
  }

  throw new Error(`${name} has ${tag}=${String(tags[tag])}; expected ${expected}.`);
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
