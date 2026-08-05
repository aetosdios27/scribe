import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  classifyInvokedBinary,
  delegateToLocalCli,
  delegationMarker,
  findSupportedProjectRoot,
  isSupportedProject,
  resolveExecutionContext,
  resolveLocalCli,
  shouldDelegate
} from "./launcher.js";

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scribe-launcher-"));
  for (const [name, value] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), value);
  }
  return root;
}

async function fakeLocalCli(root: string, version = "9.9.9", entry = "dist/index.mjs"): Promise<string> {
  const directory = join(root, "node_modules", "@scribe-sdk", "cli");
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({
    name: "@scribe-sdk/cli",
    version,
    bin: { scribe: `./${entry}` }
  }));
  await writeFile(join(directory, entry), "console.log('local');\n");
  return directory;
}

it("classifies the invoked binary from the executable path", () => {
  expect(classifyInvokedBinary("/project/node_modules/.bin/scribe")).toBe("scribe");
  expect(classifyInvokedBinary("/project/node_modules/.bin/scb")).toBe("scb");
  expect(classifyInvokedBinary("C:\\project\\node_modules\\.bin\\scb.exe")).toBe("scb");
  expect(classifyInvokedBinary("/package/dist/index.mjs")).toBe("other");
  expect(classifyInvokedBinary(undefined)).toBe("other");
});

it("finds the nearest supported React project by walking up", async () => {
  const root = await project({
    "package.json": JSON.stringify({ dependencies: { react: "19.2.7", next: "16.2.11" } })
  });
  const nested = join(root, "a", "b", "c");
  await mkdir(nested, { recursive: true });
  expect(await findSupportedProjectRoot(nested)).toBe(root);
  expect(await isSupportedProject(root)).toBe(true);
  expect(await isSupportedProject(await project({ "package.json": "{}" }))).toBe(false);
});

it("rejects a project-local CLI whose entry escapes its package root", async () => {
  const root = await project({ "package.json": JSON.stringify({ private: true }) });
  await mkdir(join(root, "node_modules", "@scribe-sdk", "cli"), { recursive: true });
  await writeFile(join(root, "node_modules", "@scribe-sdk", "cli", "package.json"), JSON.stringify({
    name: "@scribe-sdk/cli",
    version: "1.0.0",
    bin: { scribe: "../../../../escape.js" }
  }));
  expect(await resolveLocalCli(root)).toBeUndefined();
});

it("resolves a real project-local CLI with a realpathed entry", async () => {
  const root = await project({ "package.json": JSON.stringify({ dependencies: { react: "19.2.7", vite: "8.1.3" } }) });
  await fakeLocalCli(root);
  const local = await resolveLocalCli(root);
  expect(local?.version).toBe("9.9.9");
  expect(local?.entry.endsWith("dist/index.mjs")).toBe(true);
  expect(local?.packageRoot.endsWith(join("node_modules", "@scribe-sdk", "cli"))).toBe(true);
});

it("classifies user-level, project-local, delegated, and ephemeral execution", async () => {
  const root = await project({ "package.json": JSON.stringify({ dependencies: { react: "19.2.7", vite: "8.1.3" } }) });
  const local = await fakeLocalCli(root);

  const globalContext = await resolveExecutionContext({
    cwd: root,
    argv1: "/global/bin/scribe",
    packageRoot: "/global/node_modules/@scribe-sdk/cli",
    packageVersion: "0.0.1"
  });
  expect(globalContext.source).toBe("user-level");
  expect(globalContext.projectRoot).toBe(root);
  expect(globalContext.localCli?.version).toBe("9.9.9");
  expect(await shouldDelegate(globalContext)).toBe(true);

  const localContext = await resolveExecutionContext({
    cwd: root,
    argv1: join(local, "dist", "index.mjs"),
    packageRoot: await realpathOf(local),
    packageVersion: "9.9.9"
  });
  expect(localContext.source).toBe("project-local");
  expect(await shouldDelegate(localContext)).toBe(false);

  const delegatedContext = await resolveExecutionContext({
    cwd: root,
    argv1: "/global/bin/scribe",
    packageRoot: "/global/node_modules/@scribe-sdk/cli",
    packageVersion: "0.0.1",
    env: { [delegationMarker]: "1" }
  });
  expect(delegatedContext.source).toBe("delegated-child");
  expect(await shouldDelegate(delegatedContext)).toBe(false);

  const ephemeralContext = await resolveExecutionContext({
    cwd: await project({}),
    argv1: "/downloads/scribe-cli/index.mjs",
    packageRoot: "/downloads/scribe-cli",
    packageVersion: "0.0.2"
  });
  expect(ephemeralContext.source).toBe("ephemeral");
  expect(ephemeralContext.projectRoot).toBeUndefined();
  expect(await shouldDelegate(ephemeralContext)).toBe(false);
});

it("prevents delegation when the project-local package is the running package", async () => {
  const root = await project({ "package.json": JSON.stringify({ dependencies: { react: "19.2.7", vite: "8.1.3" } }) });
  const local = await fakeLocalCli(root, "1.2.3");
  const packageRoot = await realpathOf(local);
  const context = await resolveExecutionContext({
    cwd: root,
    argv1: "/project/node_modules/.bin/scribe",
    packageRoot,
    packageVersion: "1.2.3"
  });
  expect(context.source).toBe("project-local");
  expect(await shouldDelegate(context)).toBe(false);
});

it("never delegates when the recursion marker is present, even with a foreign local CLI", async () => {
  const root = await project({ "package.json": JSON.stringify({ dependencies: { react: "19.2.7", vite: "8.1.3" } }) });
  await fakeLocalCli(root);
  const context = await resolveExecutionContext({
    cwd: root,
    argv1: "/global/bin/scribe",
    packageRoot: "/global/node_modules/@scribe-sdk/cli",
    packageVersion: "0.0.1",
    env: { [delegationMarker]: "true" }
  });
  expect(await shouldDelegate(context)).toBe(false);
});

it("delegates the complete invocation once, preserving args, cwd, marker, and exit code", async () => {
  const root = await project({ "package.json": JSON.stringify({ dependencies: { react: "19.2.7", vite: "8.1.3" } }) });
  const entry = join(await fakeLocalCli(root), "dist", "index.mjs");
  await writeFile(entry, [
    'import { writeFileSync } from "node:fs";',
    'import { resolve } from "node:path";',
    'writeFileSync(resolve(process.cwd(), "delegated.json"), JSON.stringify({',
    "  args: process.argv.slice(2),",
    "  marker: process.env.SCRIBE_DELEGATED ?? null,",
    "  cwd: process.cwd(),",
    "  argv1: process.argv[1]",
    "}));",
    "process.exit(7);",
    ""
  ].join("\n"));

  const context = await resolveExecutionContext({
    cwd: root,
    argv1: "/global/bin/scribe",
    packageRoot: "/global/node_modules/@scribe-sdk/cli",
    packageVersion: "0.0.1"
  });
  const status = await delegateToLocalCli(context, ["validate", "./a.mdx", "--strict"]);

  expect(status).toBe(7);
  const record = JSON.parse(await readFile(join(root, "delegated.json"), "utf8")) as {
    args: string[];
    marker: string | null;
    cwd: string;
    argv1: string;
  };
  expect(record.args).toEqual(["validate", "./a.mdx", "--strict"]);
  expect(record.marker).toBe("1");
  expect(record.cwd).toBe(root);
  expect(record.argv1).toBe(entry);
});

it("supports injected spawn for isolated delegation decisions", async () => {
  const root = await project({ "package.json": JSON.stringify({ dependencies: { react: "19.2.7", vite: "8.1.3" } }) });
  await fakeLocalCli(root);
  const context = await resolveExecutionContext({
    cwd: root,
    argv1: "/global/bin/scribe",
    packageRoot: "/global/node_modules/@scribe-sdk/cli",
    packageVersion: "0.0.1"
  });
  let spawned: { command: string; args: readonly string[]; options: { cwd: string; env: Record<string, string | undefined> } } | undefined;
  const status = await delegateToLocalCli(context, ["--version"], {
    spawnImpl: async (command, args, options) => {
      spawned = { command, args, options };
      return 3;
    }
  });
  expect(status).toBe(3);
  expect(spawned?.command).toBe(process.execPath);
  expect(spawned?.args[1]).toBe("--version");
  expect(spawned?.options.cwd).toBe(root);
  expect(spawned?.options.env[delegationMarker]).toBe("1");
});

async function realpathOf(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(path);
}
