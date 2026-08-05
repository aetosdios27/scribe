import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { updateCommand, type PackageManager } from "./package-manager.js";

export interface InstalledPackageVersion {
  readonly name: "cli" | "mdx" | "react" | "styles";
  readonly version?: string;
}

export interface AlignmentReport {
  readonly expected: string;
  readonly installed: readonly InstalledPackageVersion[];
  readonly aligned: boolean;
}

const packageNames = ["cli", "mdx", "react", "styles"] as const;

export async function checkPackageAlignment(projectRoot: string, expected: string): Promise<AlignmentReport> {
  const installed: InstalledPackageVersion[] = [];
  for (const name of packageNames) {
    const version = await installedVersion(resolve(projectRoot, "node_modules", "@scribe-sdk", name));
    installed.push(version === undefined ? { name } : { name, version });
  }
  const known = installed.filter((entry): entry is InstalledPackageVersion & { readonly version: string } => entry.version !== undefined);
  const aligned = known.length === packageNames.length && known.every((entry) => entry.version === expected);
  return { expected, installed, aligned };
}

export function formatAlignmentDiagnostic(report: AlignmentReport, manager: PackageManager): string {
  const versions = report.installed.map((entry) => `  ${entry.name.toUpperCase().padEnd(10)}${entry.version ?? "not installed"}`).join("\n");
  return [
    "Scribe package versions do not match.",
    "",
    versions,
    "",
    "Update them together:",
    "",
    `  ${updateCommand(manager)}`
  ].join("\n");
}

async function installedVersion(packageDirectory: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8")) as { readonly version?: string };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}
