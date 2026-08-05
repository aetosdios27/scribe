import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";
export type SupportedPackageManager = "bun" | "npm";

export function isSupportedPackageManager(manager: PackageManager): manager is SupportedPackageManager {
  return manager === "bun" || manager === "npm";
}

export async function detectPackageManager(root: string, declaration?: string): Promise<PackageManager> {
  for (const [filename, manager] of [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"]
  ] as const) {
    if (await pathExists(resolve(root, filename))) return manager;
  }
  const declared = declaration?.split("@")[0];
  return declared === "bun" || declared === "pnpm" || declared === "yarn" || declared === "npm" ? declared : "npm";
}

export function installCommand(
  manager: PackageManager,
  packages: readonly string[],
  development: boolean
): string[] {
  if (manager === "bun") return ["bun", "add", ...(development ? ["--dev"] : []), ...packages];
  if (manager === "pnpm") return ["pnpm", "add", ...(development ? ["-D"] : []), ...packages];
  if (manager === "yarn") return ["yarn", "add", ...(development ? ["-D"] : []), ...packages];
  return ["npm", "install", ...(development ? ["--save-dev"] : []), ...packages];
}

export function removeCommand(manager: SupportedPackageManager, packages: readonly string[]): string[] {
  if (manager === "bun") return ["bun", "remove", ...packages];
  return ["npm", "uninstall", ...packages];
}

export function updateCommand(manager: PackageManager, expected: string): readonly string[] {
  const runtime = ["@scribe-sdk/react", "@scribe-sdk/styles", "@scribe-sdk/mdx"]
    .map((name) => `${name}@${expected}`)
    .join(" ");
  const cli = `@scribe-sdk/cli@${expected}`;
  if (manager === "bun") return [`bun update ${runtime} ${cli}`];
  if (manager === "npm") return [`npm update ${runtime} ${cli}`];
  if (manager === "pnpm") return [`pnpm add ${runtime}`, `pnpm add -D ${cli}`];
  return [`yarn add ${runtime}`, `yarn add -D ${cli}`];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
