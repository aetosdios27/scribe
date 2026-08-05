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

it("builds bun and npm install commands as argument arrays with exact versions", async () => {
  const packages = ["@scribe-sdk/react@0.1.0-alpha.8", "@scribe-sdk/styles@0.1.0-alpha.8"];
  expect(installCommand("bun", packages, false)).toEqual(["bun", "add", ...packages]);
  expect(installCommand("bun", packages, true)).toEqual(["bun", "add", "--dev", ...packages]);
  expect(installCommand("npm", packages, false)).toEqual(["npm", "install", ...packages]);
  expect(installCommand("npm", packages, true)).toEqual(["npm", "install", "--save-dev", ...packages]);
});

it("builds remove and update commands for bun and npm", async () => {
  expect(removeCommand("bun", ["@scribe-sdk/cli"])).toEqual(["bun", "remove", "@scribe-sdk/cli"]);
  expect(removeCommand("npm", ["@scribe-sdk/cli"])).toEqual(["npm", "uninstall", "@scribe-sdk/cli"]);
  expect(updateCommand("bun")).toContain("bun update");
  expect(updateCommand("npm")).toContain("npm update");
  expect(updateCommand("npm")).not.toContain("bun update");
});

it("treats only bun and npm as supported for automated installs", () => {
  expect(isSupportedPackageManager("bun")).toBe(true);
  expect(isSupportedPackageManager("npm")).toBe(true);
  expect(isSupportedPackageManager("pnpm")).toBe(false);
  expect(isSupportedPackageManager("yarn")).toBe(false);
});
