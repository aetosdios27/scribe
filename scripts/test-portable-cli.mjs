import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { executable } from "./lib/platform.mjs";

const root = process.cwd();
const release = join(root, ".scribe-release");
const manifest = JSON.parse(await readFile(join(root, "packages", "cli", "package.json"), "utf8"));
const version = manifest.version;
const directory = await mkdtemp(join(tmpdir(), "scribe portability "));
const tarballDirectory = join(directory, "tarballs");
const articleDirectory = join(directory, "articles with spaces", "unicode-記事");
const results = [];

try {
  await mkdir(tarballDirectory, { recursive: true });
  await mkdir(articleDirectory, { recursive: true });

  const dependencies = {};
  for (const name of ["mdx", "react", "styles", "cli"]) {
    const filename = `scribe-sdk-${name}-${version}.tgz`;
    await copyFile(join(release, filename), join(tarballDirectory, filename));
    dependencies[`@scribe-sdk/${name}`] = `file:./tarballs/${filename}`;
  }

  await write(join(directory, "package.json"), JSON.stringify({
    name: "scribe-portability-smoke",
    private: true,
    type: "module",
    dependencies: { ...dependencies, react: "19.2.7", vite: "8.1.3" },
    overrides: dependencies
  }, null, 2));

  const valid = join(articleDirectory, "valid article.mdx");
  const invalid = join(articleDirectory, "invalid article.mdx");
  await write(valid, "# Portable article\r\n\r\n```ts filename=\"src/portable.ts\" lineNumbers highlight=\"1\"\r\nexport const portable = true\r\n```\r\n");
  await write(invalid, '<Callout variant="warnng">Typo</Callout>\r\n');
  const globalStyle = join(directory, "src", "index.css");
  await write(globalStyle, "body { margin: 0; }\r\n");

  run(executable("bun"), ["install"], directory);
  run(executable("bun"), ["install", "--frozen-lockfile"], directory);

  const reportedVersion = runCli(["--version"]).stdout.trim();
  assert(reportedVersion === version, `scb reported ${reportedVersion}; expected ${version}.`);
  runCli(["--help"]);
  runCli(["init", "--help"]);
  runCli(["studio", "--help"]);
  const beforeInit = await readFile(globalStyle, "utf8");
  const dryRun = runCli(["init", "--dry-run"]);
  assert(dryRun.stdout.includes("Recommended style mode: default"), "Init dry run did not recommend default mode for the raw Vite fixture.");
  assert(await readFile(globalStyle, "utf8") === beforeInit, "Init dry run modified the fixture.");
  const usage = runCli([], false);
  assert(usage.status === 2, `scb without arguments exited ${usage.status}; expected 2.`);

  runCli(["validate", relative(directory, valid)]);
  runCli(["validate", resolve(valid)]);
  const rejected = runCli(["validate", relative(directory, invalid)], false);
  assert(rejected.status === 1, `Invalid article exited ${rejected.status}; expected 1.`);
  assert(rejected.stderr.includes("SCB1101"), "Invalid article did not report SCB1101.");
  assert(!/\n\s+at\s/u.test(rejected.stderr), "Invalid article exposed an internal stack trace.");

  for (const name of ["mdx", "react", "styles", "cli"]) {
    const installed = JSON.parse(await readFile(join(directory, "node_modules", "@scribe-sdk", name, "package.json"), "utf8"));
    assert(installed.version === version, `@scribe-sdk/${name} installed at ${installed.version}; expected ${version}.`);
  }
} finally {
  await mkdir(release, { recursive: true });
  await writeFile(join(release, `portability-${process.platform}.json`), `${JSON.stringify({
    platform: process.platform,
    architecture: process.arch,
    version,
    temporaryConsumer: "removed",
    results
  }, null, 2)}\n`);
  await rm(directory, { recursive: true, force: true });
}

process.stdout.write(`Packed CLI portability smoke passed on ${process.platform} for ${version}.\n`);

function runCli(args, requireSuccess = true) {
  return run(executable("bun"), ["x", "--bun", "scb", ...args], directory, requireSuccess);
}

function run(command, args, cwd, requireSuccess = true) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" }
  });
  results.push({ command: [command, ...args].join(" "), status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
  if (result.error) throw result.error;
  if (requireSuccess && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}:\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
