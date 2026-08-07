import {
  mkdir,
  mkdtemp,
  realpath,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  detectPackageManager,
  detectPackageManagerContext,
  formatPackageCommand,
  installCommand,
  isAutomatedPackageManager,
  PackageManagerDetectionError,
  scribeConvergenceCommands
} from "./package-manager.js";

async function project(
  files: Record<string, string>
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scribe-package-manager-"));
  for (const [name, value] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, value);
  }
  return root;
}

it("refuses conflicting lockfiles instead of picking one by precedence", async () => {
  const root = await project({
    "package.json": "{}",
    "bun.lock": "",
    "package-lock.json": "{}"
  });

  await expect(detectPackageManagerContext(root)).rejects.toMatchObject({
    name: "PackageManagerDetectionError",
    code: "conflicting-package-manager-signals"
  });
});

it("refuses a packageManager declaration that disagrees with the lockfile", async () => {
  const root = await project({
    "package.json": JSON.stringify({
      packageManager: "pnpm@10.15.0"
    }),
    "bun.lock": ""
  });

  await expect(detectPackageManagerContext(root)).rejects.toMatchObject({
    code: "conflicting-package-manager-signals"
  });
});

it("does not default to npm when there is no package-manager evidence", async () => {
  const root = await project({ "package.json": "{}" });

  await expect(detectPackageManager(root)).rejects.toMatchObject({
    name: "PackageManagerDetectionError",
    code: "unknown-package-manager"
  });
});

it("uses a containing workspace root as the package-manager root", async () => {
  const root = await project({
    "package.json": JSON.stringify({
      private: true,
      workspaces: ["apps/*"],
      packageManager: "bun@1.3.13"
    }),
    "bun.lock": "",
    "apps/site/package.json": JSON.stringify({
      private: true
    })
  });

  const context = await detectPackageManagerContext(
    join(root, "apps", "site")
  );

  const canonicalRoot = await realpath(root);
  const canonicalApplicationRoot = await realpath(
    join(root, "apps", "site")
  );
  expect(context.manager).toBe("bun");
  expect(context.applicationRoot).toBe(canonicalApplicationRoot);
  expect(context.packageManagerRoot).toBe(canonicalRoot);
  expect(context.lockfiles.map((entry) => entry.filename)).toContain(
    "bun.lock"
  );
});

it("skips malformed intermediate ancestors while keeping the selected workspace root strict", async () => {
  const root = await project({
    "package.json": JSON.stringify({
      private: true,
      workspaces: ["apps/*"],
      packageManager: "bun@1.3.13"
    }),
    "bun.lock": "",
    "apps/package.json": "{ malformed",
    "apps/site/package.json": JSON.stringify({ private: true })
  });

  const context = await detectPackageManagerContext(
    join(root, "apps", "site")
  );

  expect(context.manager).toBe("bun");
  expect(context.packageManagerRoot).toBe(await realpath(root));
});

it("does not inherit a random parent lockfile without a workspace boundary", async () => {
  const root = await project({
    "bun.lock": "",
    "child/package.json": "{}"
  });

  await expect(
    detectPackageManagerContext(join(root, "child"))
  ).rejects.toMatchObject({
    code: "unknown-package-manager"
  });
});

it("parses an explicit packageManager declaration when no lockfile exists", async () => {
  const root = await project({
    "package.json": JSON.stringify({
      packageManager: "pnpm@10.15.0"
    })
  });

  const context = await detectPackageManagerContext(root);
  expect(context.manager).toBe("pnpm");
  expect(context.declarations[0]).toMatchObject({
    manager: "pnpm",
    version: "10.15.0"
  });
});

it("rejects malformed packageManager declarations", async () => {
  const root = await project({
    "package.json": JSON.stringify({
      packageManager: "volta@whatever"
    })
  });

  await expect(detectPackageManagerContext(root)).rejects.toBeInstanceOf(
    PackageManagerDetectionError
  );
  await expect(detectPackageManagerContext(root)).rejects.toMatchObject({
    code: "invalid-package-manager-declaration"
  });
});

it("builds exact, argv-structured install commands", () => {
  expect(
    installCommand(
      "bun",
      ["@scribe-sdk/react@1.2.3"],
      false
    )
  ).toEqual({
    executable: "bun",
    args: ["add", "--exact", "@scribe-sdk/react@1.2.3"]
  });

  expect(
    installCommand(
      "npm",
      ["@scribe-sdk/cli@1.2.3"],
      true
    )
  ).toEqual({
    executable: "npm",
    args: [
      "install",
      "--save-exact",
      "--save-dev",
      "@scribe-sdk/cli@1.2.3"
    ]
  });
});

it("refuses to construct an empty install command", () => {
  expect(() => installCommand("npm", [], false)).toThrow();
});

it("converges every Scribe package to one exact release", () => {
  const commands = scribeConvergenceCommands("pnpm", "1.2.3");

  expect(commands).toHaveLength(2);
  expect(formatPackageCommand(commands[0]!)).toContain(
    "pnpm add --save-exact"
  );
  expect(formatPackageCommand(commands[0]!)).toContain(
    "@scribe-sdk/react@1.2.3"
  );
  expect(formatPackageCommand(commands[1]!)).toContain(
    "@scribe-sdk/cli@1.2.3"
  );
});

it("only marks bun and npm as automated mutation managers", () => {
  expect(isAutomatedPackageManager("bun")).toBe(true);
  expect(isAutomatedPackageManager("npm")).toBe(true);
  expect(isAutomatedPackageManager("pnpm")).toBe(false);
  expect(isAutomatedPackageManager("yarn")).toBe(false);
});
