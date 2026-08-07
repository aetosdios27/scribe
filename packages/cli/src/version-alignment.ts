import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  formatPackageCommand,
  scribeConvergenceCommands,
  type PackageManager
} from "./package-manager.js";

export type ScribePackageKey = "cli" | "mdx" | "react" | "styles";
export type ScribePackageName =
  | "@scribe-sdk/cli"
  | "@scribe-sdk/mdx"
  | "@scribe-sdk/react"
  | "@scribe-sdk/styles";

export interface ScribePackageDefinition {
  readonly key: ScribePackageKey;
  readonly name: ScribePackageName;
  readonly development: boolean;
}

export const scribePackageDefinitions = [
  { key: "react", name: "@scribe-sdk/react", development: false },
  { key: "styles", name: "@scribe-sdk/styles", development: false },
  { key: "mdx", name: "@scribe-sdk/mdx", development: false },
  { key: "cli", name: "@scribe-sdk/cli", development: true }
] as const satisfies readonly ScribePackageDefinition[];

export type PackageResolutionStatus = "resolved" | "missing" | "error";

export interface InstalledPackageVersion {
  readonly name: ScribePackageKey;
  readonly packageName: ScribePackageName;
  readonly status: PackageResolutionStatus;
  readonly version?: string;
  readonly manifestPath?: string;
  readonly error?: string;
}

export interface AlignmentReport {
  readonly expected: string;
  readonly installed: readonly InstalledPackageVersion[];
  readonly aligned: boolean;
  /**
   * False means inspection itself failed for at least one package. In that
   * state Scribe must not pretend a package-manager update is known to be the
   * correct repair.
   */
  readonly inspectable: boolean;
}

/**
 * Resolves the Scribe package set using normal node_modules ancestry between
 * the application root and the known package-manager root. This handles the
 * common workspace/hoisting case without accidentally walking into unrelated
 * node_modules directories above the package-manager boundary.
 *
 * Yarn PnP and other non-node_modules layouts are intentionally not guessed
 * here. Those managers are not part of Scribe's automated mutation path yet.
 */
export async function checkPackageAlignment(
  applicationRoot: string,
  expected: string,
  packageManagerRoot: string = applicationRoot
): Promise<AlignmentReport> {
  assertExactVersion(expected);

  const canonicalApplicationRoot = await realpath(applicationRoot);
  const canonicalPackageManagerRoot = await realpath(packageManagerRoot);
  assertWithinBoundary(canonicalApplicationRoot, canonicalPackageManagerRoot);

  const installed = await Promise.all(
    scribePackageDefinitions.map(async (definition) => resolveInstalledPackage(
      canonicalApplicationRoot,
      canonicalPackageManagerRoot,
      definition
    ))
  );

  const inspectable = installed.every((entry) => entry.status !== "error");
  const aligned = inspectable
    && installed.every((entry) => entry.status === "resolved" && entry.version === expected);

  return { expected, installed, aligned, inspectable };
}

export function formatAlignmentDiagnostic(report: AlignmentReport, manager: PackageManager): string {
  const versions = report.installed
    .map((entry) => `  ${entry.name.toUpperCase().padEnd(10)}${formatResolution(entry)}`)
    .join("\n");

  if (!report.inspectable) {
    return [
      "Scribe package alignment could not be verified.",
      "",
      versions,
      "",
      "Fix the inspection errors above before changing Scribe package versions."
    ].join("\n");
  }

  const commands = scribeConvergenceCommands(manager, report.expected)
    .map((command) => `  ${formatPackageCommand(command)}`);

  return [
    "Scribe package versions do not match.",
    "",
    versions,
    "",
    `Expected every Scribe package to resolve at ${report.expected}.`,
    "",
    "Converge them together:",
    "",
    ...commands
  ].join("\n");
}

async function resolveInstalledPackage(
  applicationRoot: string,
  packageManagerRoot: string,
  definition: ScribePackageDefinition
): Promise<InstalledPackageVersion> {
  const segments = definition.name.split("/").filter(Boolean);

  for (const nodeModulesRoot of nodeModulesSearchRoots(applicationRoot, packageManagerRoot)) {
    const manifestPath = resolve(nodeModulesRoot, ...segments, "package.json");
    let source: string;

    try {
      source = await readFile(manifestPath, "utf8");
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) continue;
      return {
        name: definition.key,
        packageName: definition.name,
        status: "error",
        manifestPath,
        error: `Could not read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`
      };
    }

    let manifest: { readonly name?: unknown; readonly version?: unknown };
    try {
      manifest = JSON.parse(source) as typeof manifest;
    } catch (error) {
      return {
        name: definition.key,
        packageName: definition.name,
        status: "error",
        manifestPath,
        error: `Could not parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`
      };
    }

    if (manifest.name !== undefined && manifest.name !== definition.name) {
      return {
        name: definition.key,
        packageName: definition.name,
        status: "error",
        manifestPath,
        error: `Resolved ${definition.name} to a manifest declaring ${JSON.stringify(manifest.name)}.`
      };
    }

    if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
      return {
        name: definition.key,
        packageName: definition.name,
        status: "error",
        manifestPath,
        error: `Resolved ${definition.name}, but ${manifestPath} does not contain a valid version.`
      };
    }

    return {
      name: definition.key,
      packageName: definition.name,
      status: "resolved",
      version: manifest.version,
      manifestPath
    };
  }

  return {
    name: definition.key,
    packageName: definition.name,
    status: "missing"
  };
}

function nodeModulesSearchRoots(applicationRoot: string, packageManagerRoot: string): readonly string[] {
  const roots: string[] = [];
  let current = applicationRoot;

  for (;;) {
    roots.push(resolve(current, "node_modules"));
    if (current === packageManagerRoot) return roots;

    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `Package-manager root ${packageManagerRoot} is not an ancestor of application root ${applicationRoot}.`
      );
    }
    current = parent;
  }
}

function formatResolution(entry: InstalledPackageVersion): string {
  if (entry.status === "resolved") return entry.version as string;
  if (entry.status === "missing") return "not resolved";
  return `inspection failed — ${entry.error ?? "unknown error"}`;
}

function assertWithinBoundary(applicationRoot: string, packageManagerRoot: string): void {
  const value = relative(packageManagerRoot, applicationRoot);
  if (value === "") return;
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error(
      `Application root ${applicationRoot} is outside package-manager root ${packageManagerRoot}.`
    );
  }
}

function assertExactVersion(version: string): void {
  const normalized = version.trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(normalized)) {
    throw new Error(`Expected an exact Scribe version, received ${JSON.stringify(version)}.`);
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === code;
}
