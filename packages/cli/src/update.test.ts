import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { formatPackageCommand, type PackageCommand } from "./package-manager.js";
import { checkPackageAlignment, scribePackageDefinitions } from "./version-alignment.js";
import { resolveScribePrereleaseTarget, runUpdate } from "./update.js";

const alpha = "0.1.0-alpha.10";
const beta = "0.1.0-beta";

it("resolves one aligned beta target across all four registry packages", async () => {
  const requested: { readonly url: string; readonly accept: string | null }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requested.push({
      url: String(input),
      accept: new Headers(init?.headers).get("accept")
    });
    return new Response(JSON.stringify({ "dist-tags": { beta } }), { status: 200 });
  });

  await expect(resolveScribePrereleaseTarget(fetchImpl as typeof fetch)).resolves.toBe(beta);
  expect(requested).toHaveLength(4);
  expect(requested.every(({ url }) => url.startsWith("https://registry.npmjs.org/"))).toBe(true);
  expect(requested.every(({ accept }) => accept === "application/vnd.npm.install-v1+json, application/json")).toBe(true);
});

it("reports an aligned installation as already current", async () => {
  const cwd = await projectFixture("bun", Object.fromEntries(
    scribePackageDefinitions.map(({ name }) => [name, beta])
  ));
  const stdout = vi.fn();
  const runCommand = vi.fn(async () => 0);

  expect(await runUpdate([], {
    cwd,
    version: beta,
    stdout,
    stderr: vi.fn(),
    resolveTarget: async () => beta,
    runCommand
  })).toBe(0);

  const output = stdout.mock.calls.join("\n");
  expect(output).toContain(`${beta} → ${beta}`);
  expect(output).toContain("Already current");
  expect(runCommand).not.toHaveBeenCalled();
});

it("reports a mismatched installation clearly in a dry run", async () => {
  const cwd = await projectFixture("bun", {
    "@scribe-sdk/react": alpha,
    "@scribe-sdk/styles": "0.1.0-alpha.9",
    "@scribe-sdk/mdx": alpha,
    "@scribe-sdk/cli": alpha
  });
  const stdout = vi.fn();

  expect(await runUpdate(["--dry-run"], {
    cwd,
    version: alpha,
    stdout,
    stderr: vi.fn(),
    resolveTarget: async () => beta
  })).toBe(0);

  const output = stdout.mock.calls.join("\n");
  expect(output).toContain(`mixed → ${beta}`);
  expect(output).toContain("@scribe-sdk/styles  0.1.0-alpha.9");
  expect(output).toContain("bun add --exact");
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
  const cwd = await projectFixture(manager, Object.fromEntries(
    scribePackageDefinitions.map(({ name }) => [name, alpha])
  ));
  const commands: PackageCommand[] = [];
  const runCommand = vi.fn(async (command: PackageCommand) => {
    commands.push(command);
    if (commands.length === 2) await installVersions(cwd, beta);
    const manifestPath = join(cwd, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest["scribeUpdateCommand"] = commands.length;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const lockfile = manager === "bun" ? "bun.lock" : "package-lock.json";
    await writeFile(join(cwd, lockfile), `updated-${commands.length}\n`);
    return 0;
  });
  const stdout = vi.fn();

  expect(await runUpdate(["--yes"], {
    cwd,
    version: alpha,
    stdout,
    stderr: vi.fn(),
    resolveTarget: async () => beta,
    runCommand
  })).toBe(0);

  expect(commands.map(formatPackageCommand)).toEqual(expectedCommands);
  expect(stdout.mock.calls.join("\n")).toContain(`All four Scribe packages now resolve at ${beta}`);
  await expect(checkPackageAlignment(cwd, beta)).resolves.toMatchObject({ aligned: true });
});

it.each(["pnpm", "yarn"] as const)("does not automate updates with %s", async (manager) => {
  const cwd = await projectFixture(manager, Object.fromEntries(
    scribePackageDefinitions.map(({ name }) => [name, alpha])
  ));
  const runCommand = vi.fn(async () => 0);

  expect(await runUpdate([], {
    cwd,
    version: alpha,
    stdout: vi.fn(),
    stderr: vi.fn(),
    resolveTarget: async () => beta,
    runCommand
  })).toBe(2);
  expect(runCommand).not.toHaveBeenCalled();
});

it("writes a cancelled receipt when the update is declined", async () => {
  const cwd = await projectFixture("bun", Object.fromEntries(
    scribePackageDefinitions.map(({ name }) => [name, alpha])
  ));
  const stdout = vi.fn();
  const runCommand = vi.fn(async () => 0);

  expect(await runUpdate([], {
    cwd,
    version: alpha,
    stdout,
    stderr: vi.fn(),
    confirm: async () => false,
    resolveTarget: async () => beta,
    runCommand
  })).toBe(0);
  expect(stdout.mock.calls.join("\n")).toContain("No package-manager commands were run");
  expect(runCommand).not.toHaveBeenCalled();
});

it("rejects non-interactive update confirmation without running commands", async () => {
  const cwd = await projectFixture("npm", Object.fromEntries(
    scribePackageDefinitions.map(({ name }) => [name, alpha])
  ));
  const stderr = vi.fn();
  const runCommand = vi.fn(async () => 0);

  expect(await runUpdate([], {
    cwd,
    version: alpha,
    stdout: vi.fn(),
    stderr,
    confirm: async () => null,
    resolveTarget: async () => beta,
    runCommand
  })).toBe(2);
  expect(stderr.mock.calls.join("\n")).toContain("non-interactive");
  expect(runCommand).not.toHaveBeenCalled();
});

it("reports verified success when only integration lock cleanup fails", async () => {
  const cwd = await projectFixture("bun", Object.fromEntries(
    scribePackageDefinitions.map(({ name }) => [name, alpha])
  ));
  const stdout = vi.fn();
  const stderr = vi.fn();
  let commands = 0;

  expect(await runUpdate(["--yes"], {
    cwd,
    version: alpha,
    stdout,
    stderr,
    resolveTarget: async () => beta,
    runCommand: async () => {
      commands += 1;
      if (commands === 2) await installVersions(cwd, beta);
      return 0;
    },
    releaseLock: async () => {
      throw new Error("cleanup unavailable");
    }
  })).toBe(0);
  expect(stdout.mock.calls.join("\n")).toContain(`All four Scribe packages now resolve at ${beta}`);
  expect(stderr.mock.calls.join("\n")).toContain("lock cleanup failed");
});

it("rolls back tracked package files and never reports partial success after a failed update", async () => {
  const cwd = await projectFixture("bun", Object.fromEntries(
    scribePackageDefinitions.map(({ name }) => [name, alpha])
  ));
  const manifestBefore = await readFile(join(cwd, "package.json"), "utf8");
  const lockBefore = await readFile(join(cwd, "bun.lock"), "utf8");
  const stdout = vi.fn();
  const stderr = vi.fn();

  expect(await runUpdate(["--yes"], {
    cwd,
    version: alpha,
    stdout,
    stderr,
    resolveTarget: async () => beta,
    runCommand: async () => {
      await writeFile(join(cwd, "package.json"), "{\"partially\":true}\n");
      await writeFile(join(cwd, "bun.lock"), "partial\n");
      return 1;
    }
  })).toBe(1);

  await expect(readFile(join(cwd, "package.json"), "utf8")).resolves.toBe(manifestBefore);
  await expect(readFile(join(cwd, "bun.lock"), "utf8")).resolves.toBe(lockBefore);
  expect(stderr.mock.calls.join("\n")).toContain("did not report the installation as updated");
  expect(stdout.mock.calls.join("\n")).not.toContain("All four Scribe packages now resolve");
});

async function projectFixture(
  manager: "bun" | "npm" | "pnpm" | "yarn",
  versions: Readonly<Record<string, string>>
): Promise<string> {
  const packageManagerVersions = {
    bun: "1.3.13",
    npm: "11.6.2",
    pnpm: "10.0.0",
    yarn: "4.0.0"
  } as const;
  const lockfiles = {
    bun: "bun.lock",
    npm: "package-lock.json",
    pnpm: "pnpm-lock.yaml",
    yarn: "yarn.lock"
  } as const;
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
  for (const { name } of scribePackageDefinitions) {
    const directory = join(cwd, "node_modules", ...name.split("/"));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, version: versions[name] }));
  }
  return cwd;
}

async function installVersions(cwd: string, version: string): Promise<void> {
  for (const { name } of scribePackageDefinitions) {
    await writeFile(
      join(cwd, "node_modules", ...name.split("/"), "package.json"),
      JSON.stringify({ name, version })
    );
  }
}
