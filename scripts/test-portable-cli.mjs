import { spawnSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { executable, requiresCommandShell } from "./lib/platform.mjs";

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
    scripts: { "scribe:version": "scribe --version" },
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

  for (const command of ["scribe", "scb"]) {
    const reportedVersion = runCli(command, ["--version"]).stdout.trim();
    assert(reportedVersion === version, `${command} reported ${reportedVersion}; expected ${version}.`);
    runCli(command, ["--help"]);
    runCli(command, ["validate", "--help"]);
  }
  runCli("scribe", ["init", "--help"]);
  runCli("scribe", ["studio", "--help"]);
  run(executable("bun"), ["run", "scribe:version"], directory);
  const beforeInit = await readFile(globalStyle, "utf8");
  const dryRun = runCli("scribe", ["init", "--dry-run"]);
  assert(dryRun.stdout.includes("Recommendation") && dryRun.stdout.includes("Mode    default"), "Init dry run did not recommend default mode for the raw Vite fixture.");
  assert(await readFile(globalStyle, "utf8") === beforeInit, "Init dry run modified the fixture.");
  const usage = runCli("scribe", [], false);
  assert(usage.status === 2, `scribe without arguments exited ${usage.status}; expected 2.`);

  const validResult = runCli("scribe", ["validate", relative(directory, valid)]);
  assert(!/\u001B\[/u.test(`${validResult.stdout}${validResult.stderr}`), "Captured CLI output contained ANSI styling.");
  runCli("scribe", ["validate", resolve(valid)]);
  runCli("scb", ["validate", relative(directory, valid)]);
  const noColor = runCli("scribe", ["validate", relative(directory, valid)], true, { NO_COLOR: "1" });
  assert(!/\u001B\[/u.test(`${noColor.stdout}${noColor.stderr}`), "NO_COLOR output contained ANSI styling.");
  const rejected = runCli("scribe", ["validate", relative(directory, invalid)], false);
  assert(rejected.status === 1, `Invalid article exited ${rejected.status}; expected 1.`);
  assert(rejected.stderr.includes("SCB1101"), "Invalid article did not report SCB1101.");
  assert(!/\n\s+at\s/u.test(rejected.stderr), "Invalid article exposed an internal stack trace.");

  for (const name of ["mdx", "react", "styles", "cli"]) {
    const installed = JSON.parse(await readFile(join(directory, "node_modules", "@scribe-sdk", name, "package.json"), "utf8"));
    assert(installed.version === version, `@scribe-sdk/${name} installed at ${installed.version}; expected ${version}.`);
  }

  await verifyLocalNpmInstall();
  await verifyGlobalInstalls();
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

function runCli(command, args, requireSuccess = true, env = {}) {
  return run(executable("bun"), ["x", "--bun", command, ...args], directory, requireSuccess, env);
}

function run(command, args, cwd, requireSuccess = true, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: requiresCommandShell(command),
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1", ...env }
  });
  if (result.error) throw result.error;
  results.push({ command: [command, ...args].join(" "), status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
  if (requireSuccess && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}:\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function verifyLocalNpmInstall() {
  const npmDirectory = join(directory, "npm-local");
  await mkdir(npmDirectory, { recursive: true });
  await write(join(npmDirectory, "package.json"), JSON.stringify({
    name: "scribe-portability-npm-smoke",
    private: true,
    dependencies: {
      "@scribe-sdk/cli": "file:../tarballs/scribe-sdk-cli-" + version + ".tgz",
      "@scribe-sdk/mdx": "file:../tarballs/scribe-sdk-mdx-" + version + ".tgz",
      "@scribe-sdk/react": "file:../tarballs/scribe-sdk-react-" + version + ".tgz",
      "@scribe-sdk/styles": "file:../tarballs/scribe-sdk-styles-" + version + ".tgz",
      react: "19.2.7",
      "react-dom": "19.2.7"
    },
    overrides: { "js-yaml": "4.3.0" }
  }, null, 2));
  run(executable("npm"), ["install", "--no-audit", "--no-fund"], npmDirectory);
  const npmVersion = run(executable("npx"), ["--no-install", "scribe", "--version"], npmDirectory).stdout.trim();
  assert(npmVersion === version, `Local npm scribe reported ${npmVersion}; expected ${version}.`);
  assert(run(executable("npx"), ["--no-install", "scb", "--version"], npmDirectory).stdout.trim() === version, "Local npm scb alias reported a different version.");
}

async function verifyGlobalInstalls() {
  const packageTarballs = ["mdx", "react", "styles", "cli"]
    .map((name) => join(tarballDirectory, `scribe-sdk-${name}-${version}.tgz`));

  const npmPrefix = join(directory, "npm-global");
  run(executable("npm"), ["install", "--global", "--prefix", npmPrefix, "--no-audit", "--no-fund", ...packageTarballs], directory);
  const npmScribe = await findExecutable(process.platform === "win32" ? npmPrefix : join(npmPrefix, "bin"), "scribe");
  const npmVersion = run(npmScribe, ["--version"], directory).stdout.trim();
  assert(npmVersion === version, `Global npm scribe reported ${npmVersion}; expected ${version}.`);
  const npmAlias = await findExecutable(process.platform === "win32" ? npmPrefix : join(npmPrefix, "bin"), "scb");
  assert(run(npmAlias, ["--version"], directory).stdout.trim() === version, "Global npm scb alias reported a different version.");

  const bunHome = join(directory, "bun-global");
  const bunEnv = { BUN_INSTALL: bunHome };
  run(executable("bun"), ["add", "--global", ...packageTarballs], directory, true, bunEnv);
  const bunBinDirectory = run(executable("bun"), ["pm", "bin", "-g"], directory, true, bunEnv).stdout.trim();
  const bunScribe = await findExecutable(bunBinDirectory, "scribe");
  const bunVersion = run(bunScribe, ["--version"], directory, true, bunEnv).stdout.trim();
  assert(bunVersion === version, `Global Bun scribe reported ${bunVersion}; expected ${version}.`);
  const bunAlias = await findExecutable(bunBinDirectory, "scb");
  assert(run(bunAlias, ["--version"], directory, true, bunEnv).stdout.trim() === version, "Global Bun scb alias reported a different version.");
}

async function findExecutable(directory, name) {
  for (const candidate of process.platform === "win32"
    ? [`${name}.exe`, `${name}.cmd`, name]
    : [name]) {
    const path = join(directory, candidate);
    try {
      await access(path);
      return path;
    } catch {
      // Continue through platform shims.
    }
  }
  throw new Error(`Could not find ${name} in ${directory}.`);
}

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
