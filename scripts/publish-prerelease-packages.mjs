import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { spawnPortableSync } from "./lib/spawn.mjs";

export const nativePackages = [
  { name: "@scribe-sdk/cli-linux-x64-gnu", directory: "linux-x64-gnu" },
  { name: "@scribe-sdk/cli-linux-x64-musl", directory: "linux-x64-musl" },
  { name: "@scribe-sdk/cli-linux-arm64-gnu", directory: "linux-arm64-gnu" },
  { name: "@scribe-sdk/cli-linux-arm64-musl", directory: "linux-arm64-musl" },
  { name: "@scribe-sdk/cli-darwin-x64", directory: "darwin-x64" },
  { name: "@scribe-sdk/cli-darwin-arm64", directory: "darwin-arm64" },
  { name: "@scribe-sdk/cli-win32-x64-msvc", directory: "win32-x64-msvc" },
  { name: "@scribe-sdk/cli-win32-arm64-msvc", directory: "win32-arm64-msvc" }
];
export const publicPackages = [
  { name: "@scribe-sdk/styles", directory: "styles" },
  { name: "@scribe-sdk/react", directory: "react" },
  { name: "@scribe-sdk/mdx", directory: "mdx" },
  ...nativePackages,
  { name: "@scribe-sdk/cli", directory: "cli" }
];

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function publishPrereleasePackages({
  root = defaultRoot,
  registry = npmRegistry,
  distTagAttempts = 60,
  distTagDelayMs = 1_000
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
  const channel = pre.tag;
  assert(
    pre.mode === "pre" && (channel === "alpha" || channel === "beta"),
    "Package publication requires Changesets alpha or beta prerelease mode."
  );

  const releases = await Promise.all(publicPackages.map(async ({ name, directory }) => {
    const native = name !== "@scribe-sdk/cli" && name.startsWith("@scribe-sdk/cli-");
    const manifestRoot = native
      ? join(root, "packages", "cli-native", directory)
      : join(root, "packages", directory);
    const manifest = await readJson(join(manifestRoot, "package.json"));
    assert(manifest.name === name, `Expected ${name} in ${manifestRoot}.`);
    assert(
      new RegExp(`^\\d+\\.\\d+\\.\\d+-${channel}(?:\\.\\d+)*$`, "u").test(manifest.version),
      `${name}@${String(manifest.version)} is not a ${channel} prerelease.`
    );
    return {
      name,
      version: manifest.version,
      tarball: join(root, ".scribe-release", `${name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`)
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
      process.stdout.write(`Publishing ${release.name}@${release.version} with the ${channel} dist-tag.\n`);
      await registry.publishTarball(release.name, release.tarball, channel);
    } else {
      process.stdout.write(`Skipping ${release.name}@${release.version}; it is already published.\n`);
    }

    await assertTagConverged(registry, release.name, channel, version, { attempts: distTagAttempts, delayMs: distTagDelayMs });
  }

  process.stdout.write(`Verified all public packages at ${channel}=${version}.\n`);
}

const npmRegistry = {
  async versions(name) {
    const value = runNpmJsonOptional(["view", name, "versions", "--json"]);
    return Array.isArray(value) ? value : [value];
  },
  async distTags(name) {
    return runNpmJson(["view", name, "dist-tags", "--json"]);
  },
  async publishTarball(_name, tarball, tag) {
    runNpm(["publish", tarball, "--tag", tag, "--access", "public"], "inherit");
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

function runNpmJsonOptional(args) {
  const output = runNpmOptional(args, "pipe");
  return output === "" ? undefined : JSON.parse(output);
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

function runNpmOptional(args, stdio) {
  const result = spawnPortableSync("npm", args, {
    cwd: defaultRoot,
    encoding: "utf8",
    stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"]
  });
  if (result.status === 0) return result.stdout ?? "";
  if (result.status === 1 && /(?:E404|is not in this registry|Not Found)/iu.test(result.stderr ?? "")) return "";
  throw new Error(`npm ${args.join(" ")} exited with code ${String(result.status)}.`);
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
  await publishPrereleasePackages();
}
