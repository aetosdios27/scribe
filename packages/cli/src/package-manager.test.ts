import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  detectPackageManager,
  installCommand,
  isSupportedPackageManager,
  removeCommand,
  updateCommand
} from "./package-manager.js";

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scribe-package-manager-"));
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(root, name), value);
  }
  return root;
}

it("detects bun from either lockfile before npm", async () => {
  expect(await detectPackageManager(await project({ "bun.lock": "", "package-lock.json": "{}" }))).toBe("bun");
  expect(await detectPackageManager(await project({ "bun.lockb": "" }))).toBe("bun");
});

it("detects npm, pnpm, and yarn from their lockfiles", async () => {
  expect(await detectPackageManager(await project({ "package-lock.json": "{}" }))).toBe("npm");
  expect(await detectPackageManager(await project({ "pnpm-lock.yaml": "" }))).toBe("pnpm");
  expect(await detectPackageManager(await project({ "yarn.lock": "" }))).toBe("yarn");
});

it("falls back to the declared packageManager field or npm", async () => {
  expect(await detectPackageManager(await project({}), "bun@1.3.13")).toBe("bun");
  expect(await detectPackageManager(await project({}), "npm@10.0.0")).toBe("npm");
  expect(await detectPackageManager(await project({}))).toBe("npm");
});

it("builds manager-native install commands with the dev flag split", async () => {
  const packages = ["@scribe-sdk/react@0.1.0-alpha.8", "@scribe-sdk/styles@0.1.0-alpha.8"];
  expect(installCommand("bun", packages, false)).toEqual(["bun", "add", ...packages]);
  expect(installCommand("bun", packages, true)).toEqual(["bun", "add", "--dev", ...packages]);
  expect(installCommand("npm", packages, false)).toEqual(["npm", "install", ...packages]);
  expect(installCommand("npm", packages, true)).toEqual(["npm", "install", "--save-dev", ...packages]);
  expect(installCommand("pnpm", packages, false)).toEqual(["pnpm", "add", ...packages]);
  expect(installCommand("pnpm", packages, true)).toEqual(["pnpm", "add", "-D", ...packages]);
  expect(installCommand("yarn", packages, false)).toEqual(["yarn", "add", ...packages]);
  expect(installCommand("yarn", packages, true)).toEqual(["yarn", "add", "-D", ...packages]);
});

it("builds remove and update commands for every package manager", async () => {
  expect(removeCommand("bun", ["@scribe-sdk/cli"])).toEqual(["bun", "remove", "@scribe-sdk/cli"]);
  expect(removeCommand("npm", ["@scribe-sdk/cli"])).toEqual(["npm", "uninstall", "@scribe-sdk/cli"]);
  expect(updateCommand("bun", "0.1.0-alpha.8")).toEqual([
    "bun update @scribe-sdk/react@0.1.0-alpha.8 @scribe-sdk/styles@0.1.0-alpha.8 @scribe-sdk/mdx@0.1.0-alpha.8 @scribe-sdk/cli@0.1.0-alpha.8"
  ]);
  expect(updateCommand("npm", "0.1.0-alpha.8")).toEqual([
    "npm install @scribe-sdk/react@0.1.0-alpha.8 @scribe-sdk/styles@0.1.0-alpha.8 @scribe-sdk/mdx@0.1.0-alpha.8",
    "npm install --save-dev @scribe-sdk/cli@0.1.0-alpha.8"
  ]);
  expect(updateCommand("pnpm", "0.1.0-alpha.8")).toEqual([
    "pnpm add @scribe-sdk/react@0.1.0-alpha.8 @scribe-sdk/styles@0.1.0-alpha.8 @scribe-sdk/mdx@0.1.0-alpha.8",
    "pnpm add -D @scribe-sdk/cli@0.1.0-alpha.8"
  ]);
  expect(updateCommand("yarn", "0.1.0-alpha.8")).toEqual([
    "yarn add @scribe-sdk/react@0.1.0-alpha.8 @scribe-sdk/styles@0.1.0-alpha.8 @scribe-sdk/mdx@0.1.0-alpha.8",
    "yarn add -D @scribe-sdk/cli@0.1.0-alpha.8"
  ]);
});

it("treats only bun and npm as supported for automated installs", () => {
  expect(isSupportedPackageManager("bun")).toBe(true);
  expect(isSupportedPackageManager("npm")).toBe(true);
  expect(isSupportedPackageManager("pnpm")).toBe(false);
  expect(isSupportedPackageManager("yarn")).toBe(false);
});
