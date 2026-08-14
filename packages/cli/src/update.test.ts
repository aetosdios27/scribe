import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { formatPackageCommand, type PackageCommand } from "./package-manager.js";
import { checkPackageAlignment, scribePackageDefinitions } from "./version-alignment.js";
import {
  applyScribeUpdatePlan,
  planScribeUpdate,
  resolveScribePrereleaseTarget,
  UpdateOperationError
} from "./update.js";

const alpha = "0.1.0-alpha.10";
const beta = "0.1.0-beta";

it("resolves one aligned beta target across all four registry packages", async () => {
  const requested: { readonly url: string; readonly accept: string | null }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requested.push({ url: String(input), accept: new Headers(init?.headers).get("accept") });
    return new Response(JSON.stringify({ "dist-tags": { beta } }), { status: 200 });
  });

  await expect(resolveScribePrereleaseTarget(fetchImpl as typeof fetch)).resolves.toBe(beta);
  expect(requested).toHaveLength(4);
  expect(requested.every(({ url }) => url.startsWith("https://registry.npmjs.org/"))).toBe(true);
  expect(requested.every(({ accept }) => accept === "application/vnd.npm.install-v1+json, application/json")).toBe(true);
});

it("reports an aligned installation without running package commands", async () => {
  const cwd = await projectFixture("bun", aligned(beta));
  const plan = await planScribeUpdate(cwd, beta, { resolveTarget: async () => beta });
  const runCommand = vi.fn(async () => 0);

  await expect(applyScribeUpdatePlan(plan, { runCommand })).resolves.toEqual({
    changed: false,
    target: beta
  });
  expect(runCommand).not.toHaveBeenCalled();
});

it.each([
  ["bun", [
    `bun add --exact @scribe-sdk/react@${beta} @scribe-sdk/styles@${beta} @scribe-sdk/mdx@${beta}`,
    `bun add --exact --dev @scribe-sdk/cli@${beta}`
  ]],
  ["npm", [
    `npm install --save-exact @scribe-sdk/react@${beta} @scribe-sdk/styles@${beta} @scribe-sdk/mdx@${beta}`,
    `npm install --save-exact --save-dev @scribe-sdk/cli@${beta}`
  ]]
] as const)("updates all four packages together with %s and verifies the result", async (manager, expectedCommands) => {
  const cwd = await projectFixture(manager, aligned(alpha));
  const plan = await planScribeUpdate(cwd, alpha, { resolveTarget: async () => beta });
  const commands: PackageCommand[] = [];

  const result = await applyScribeUpdatePlan(plan, {
    runCommand: async (command) => {
      commands.push(command);
      if (commands.length === 2) await installVersions(cwd, beta);
      const manifestPath = join(cwd, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      manifest.scribeUpdateCommand = commands.length;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await writeFile(join(cwd, manager === "bun" ? "bun.lock" : "package-lock.json"), `updated-${commands.length}\n`);
      return 0;
    }
  });

  expect(result).toEqual({ changed: true, target: beta });
  expect(commands.map(formatPackageCommand)).toEqual(expectedCommands);
  await expect(checkPackageAlignment(cwd, beta)).resolves.toMatchObject({ aligned: true });
});

it.each(["pnpm", "yarn"] as const)("does not automate updates with %s", async (manager) => {
  const cwd = await projectFixture(manager, aligned(alpha));
  const plan = await planScribeUpdate(cwd, alpha, { resolveTarget: async () => beta });
  const runCommand = vi.fn(async () => 0);

  await expect(applyScribeUpdatePlan(plan, { runCommand })).rejects.toMatchObject({
    usage: true,
    partialState: false
  });
  expect(runCommand).not.toHaveBeenCalled();
});

it("rolls back tracked package files after a failed update", async () => {
  const cwd = await projectFixture("bun", aligned(alpha));
  const plan = await planScribeUpdate(cwd, alpha, { resolveTarget: async () => beta });
  const manifestBefore = await readFile(join(cwd, "package.json"), "utf8");
  const lockBefore = await readFile(join(cwd, "bun.lock"), "utf8");

  await expect(applyScribeUpdatePlan(plan, {
    runCommand: async () => {
      await writeFile(join(cwd, "package.json"), "{\"partially\":true}\n");
      await writeFile(join(cwd, "bun.lock"), "partial\n");
      return 1;
    }
  })).rejects.toBeInstanceOf(UpdateOperationError);

  await expect(readFile(join(cwd, "package.json"), "utf8")).resolves.toBe(manifestBefore);
  await expect(readFile(join(cwd, "bun.lock"), "utf8")).resolves.toBe(lockBefore);
});

it("reports lock cleanup failure as partial state after verified mutation", async () => {
  const cwd = await projectFixture("bun", aligned(alpha));
  const plan = await planScribeUpdate(cwd, alpha, { resolveTarget: async () => beta });
  let commands = 0;

  await expect(applyScribeUpdatePlan(plan, {
    runCommand: async () => {
      commands += 1;
      if (commands === 2) await installVersions(cwd, beta);
      return 0;
    },
    releaseLock: async () => {
      throw new Error("cleanup unavailable");
    }
  })).rejects.toMatchObject({ partialState: true });
});

function aligned(version: string): Record<string, string> {
  return Object.fromEntries(scribePackageDefinitions.map(({ name }) => [name, version]));
}

async function projectFixture(
  manager: "bun" | "npm" | "pnpm" | "yarn",
  versions: Readonly<Record<string, string>>
): Promise<string> {
  const packageManagerVersions = { bun: "1.3.13", npm: "11.6.2", pnpm: "10.0.0", yarn: "4.0.0" } as const;
  const lockfiles = { bun: "bun.lock", npm: "package-lock.json", pnpm: "pnpm-lock.yaml", yarn: "yarn.lock" } as const;
  const cwd = await mkdtemp(join(tmpdir(), `scribe-update-${manager}-`));
  await writeFile(join(cwd, "package.json"), `${JSON.stringify({
    private: true,
    packageManager: `${manager}@${packageManagerVersions[manager]}`,
    dependencies: {
      react: "19.2.7",
      next: "16.2.11",
      "@scribe-sdk/react": versions["@scribe-sdk/react"],
      "@scribe-sdk/styles": versions["@scribe-sdk/styles"],
      "@scribe-sdk/mdx": versions["@scribe-sdk/mdx"]
    },
    devDependencies: { "@scribe-sdk/cli": versions["@scribe-sdk/cli"] }
  }, null, 2)}\n`);
  await writeFile(join(cwd, lockfiles[manager]), "fixture\n");
  await installVersions(cwd, versions["@scribe-sdk/react"] ?? alpha, versions);
  return cwd;
}

async function installVersions(
  cwd: string,
  version: string,
  versions: Readonly<Record<string, string>> = aligned(version)
): Promise<void> {
  for (const { name } of scribePackageDefinitions) {
    const directory = join(cwd, "node_modules", ...name.split("/"));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, version: versions[name] ?? version }));
  }
}
