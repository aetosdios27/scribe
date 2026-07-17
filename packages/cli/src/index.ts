#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const version = "0.0.0";

export function main(args: readonly string[] = process.argv.slice(2)): number {
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  return 1;
}

export function isMainModule(
  moduleUrl: string,
  entryPath: string | undefined,
  realpath: (path: string) => string = realpathSync
): boolean {
  if (!entryPath) return false;

  try {
    return realpath(fileURLToPath(moduleUrl)) === realpath(entryPath);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = main();
}
