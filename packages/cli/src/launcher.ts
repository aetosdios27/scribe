import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { readFileSync, realpathSync } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectPackageManagerContext,
  PackageManagerDetectionError
} from "./package-manager.js";

export const delegationMarker = "SCRIBE_DELEGATED_TO";

export type InvokedBinary = "scribe" | "scb" | "other";
export type ExecutionSource =
  | "project-local"
  | "foreign-with-local"
  | "foreign-without-local"
  | "workspace-development"
  | "delegated-child";

export interface LocalCli {
  readonly packageRoot: string;
  readonly entry: string;
  readonly version: string;
}

export interface ExecutionContext {
  readonly cwd: string;
  readonly invokedBinary: InvokedBinary;
  readonly packageRoot: string;
  readonly packageVersion: string;
  readonly projectRoot?: string;
  readonly packageManagerRoot?: string;
  readonly localCli?: LocalCli;
  readonly delegated: boolean;
  readonly source: ExecutionSource;
}

export interface DelegationOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface LauncherDependencies {
  readonly cwd?: string;
  readonly argv1?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly packageRoot?: string;
  readonly packageVersion?: string;
  readonly findProjectRoot?: (cwd: string) => Promise<string | undefined>;
  readonly findResolutionRoot?: (projectRoot: string) => Promise<ResolutionRoot>;
  readonly resolveLocal?: (projectRoot: string, resolutionRoot: string) => Promise<LocalCli | undefined>;
  readonly spawnImpl?: (
    command: string,
    args: readonly string[],
    options: DelegationOptions
  ) => Promise<number>;
  readonly workspaceDevelopment?: (
    cwd: string,
    packageRoot: string,
    resolutionRoot?: string
  ) => Promise<boolean>;
}

interface ResolutionRoot {
  readonly root: string;
  readonly packageManagerRoot?: string;
}

interface ProjectManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly workspaces?: unknown;
}

export async function resolveExecutionContext(
  dependencies: LauncherDependencies = {}
): Promise<ExecutionContext> {
  const cwd = await canonicalOrResolved(dependencies.cwd ?? process.cwd());
  const argv1 = dependencies.argv1 ?? process.argv[1];
  const env = dependencies.env ?? process.env;
  const packageRoot = await canonicalOrResolved(
    dependencies.packageRoot ?? resolveCliPackageRoot()
  );
  const packageVersion =
    dependencies.packageVersion ?? readCliVersion(packageRoot);
  assertExactVersion(packageVersion, "running Scribe CLI");

  const invokedBinary = classifyInvokedBinary(argv1);
  const projectRoot = await (
    dependencies.findProjectRoot ?? findSupportedProjectRoot
  )(cwd);

  let localCli: LocalCli | undefined;
  let packageManagerRoot: string | undefined;
  let resolutionRoot: string | undefined;

  if (projectRoot !== undefined) {
    const resolved = await (
      dependencies.findResolutionRoot ?? findLocalResolutionRoot
    )(projectRoot);
    resolutionRoot = resolved.root;
    packageManagerRoot = resolved.packageManagerRoot;
    localCli = await (
      dependencies.resolveLocal ?? resolveLocalCli
    )(projectRoot, resolutionRoot);
  }

  const delegatedTarget = env[delegationMarker];
  const delegated =
    delegatedTarget !== undefined &&
    (await canonicalMarkerTarget(delegatedTarget)) === packageRoot;

  const samePackageRoot =
    localCli !== undefined && localCli.packageRoot === packageRoot;

  const source = await classifyExecutionSource(
    {
      delegated,
      samePackageRoot,
      hasLocalCli: localCli !== undefined
    },
    cwd,
    packageRoot,
    resolutionRoot,
    dependencies.workspaceDevelopment
  );

  return {
    cwd,
    invokedBinary,
    packageRoot,
    packageVersion,
    ...(projectRoot === undefined ? {} : { projectRoot }),
    ...(packageManagerRoot === undefined ? {} : { packageManagerRoot }),
    ...(localCli === undefined ? {} : { localCli }),
    delegated,
    source
  };
}

export function shouldDelegate(context: ExecutionContext): boolean {
  return !context.delegated && context.source === "foreign-with-local";
}

export async function delegateToLocalCli(
  context: ExecutionContext,
  args: readonly string[],
  dependencies: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly spawnImpl?: (
      command: string,
      args: readonly string[],
      options: DelegationOptions
    ) => Promise<number>;
  } = {}
): Promise<number> {
  const localCli = context.localCli;
  if (localCli === undefined) {
    throw new Error("Cannot delegate without a resolved project-local CLI.");
  }

  const spawnImpl = dependencies.spawnImpl ?? spawnDelegate;
  return spawnImpl(process.execPath, [localCli.entry, ...args], {
    cwd: context.cwd,
    env: {
      ...(dependencies.env ?? process.env),
      [delegationMarker]: localCli.packageRoot
    }
  });
}

export function classifyInvokedBinary(
  argv1: string | undefined
): InvokedBinary {
  if (argv1 === undefined) return "other";

  const name = argv1
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    ?.toLowerCase()
    .replace(/\.(?:exe|cmd|ps1|js|mjs|cjs)$/u, "");

  if (name === "scribe") return "scribe";
  if (name === "scb") return "scb";
  return "other";
}

export function resolveCliPackageRoot(): string {
  return realpathSync(
    dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
  );
}

export function readCliVersion(packageRoot: string): string {
  const manifestPath = resolve(packageRoot, "package.json");

  let manifest: { readonly name?: unknown; readonly version?: unknown };
  try {
    manifest = JSON.parse(
      readFileSync(manifestPath, "utf8")
    ) as typeof manifest;
  } catch (error) {
    throw new Error(
      `Could not read the running Scribe CLI manifest at ${manifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (
    manifest.name !== undefined &&
    manifest.name !== "@scribe-sdk/cli"
  ) {
    throw new Error(
      `Expected ${manifestPath} to describe @scribe-sdk/cli, found ${JSON.stringify(
        manifest.name
      )}.`
    );
  }

  if (
    typeof manifest.version !== "string" ||
    manifest.version.trim() === ""
  ) {
    throw new Error(
      `Could not determine the running Scribe CLI version from ${manifestPath}.`
    );
  }

  assertExactVersion(manifest.version, "running Scribe CLI");
  return manifest.version;
}

export async function findSupportedProjectRoot(
  inputCwd: string
): Promise<string | undefined> {
  const cwd = await canonicalOrResolved(inputCwd);
  const boundary = await findProjectSearchBoundary(cwd);
  let current = cwd;

  for (;;) {
    if (await isSupportedProject(current)) return current;
    if (current === boundary) return undefined;

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function isSupportedProject(
  directory: string
): Promise<boolean> {
  const manifestPath = resolve(directory, "package.json");
  let source: string;

  try {
    source = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw new Error(
      `Could not inspect ${manifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  let manifest: ProjectManifest;
  try {
    manifest = JSON.parse(source) as ProjectManifest;
  } catch (error) {
    throw new Error(
      `Could not parse ${manifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies
  };

  return (
    dependencies.react !== undefined &&
    (dependencies.next !== undefined || dependencies.vite !== undefined)
  );
}

/**
 * Resolves @scribe-sdk/cli through node_modules ancestry between the
 * application root and a trusted resolution boundary. Missing is returned as
 * undefined; malformed, unreadable, or escaping installations throw.
 */
export async function resolveLocalCli(
  inputProjectRoot: string,
  inputResolutionRoot: string = inputProjectRoot
): Promise<LocalCli | undefined> {
  const projectRoot = await canonicalOrResolved(inputProjectRoot);
  const resolutionRoot = await canonicalOrResolved(inputResolutionRoot);
  assertWithinBoundary(projectRoot, resolutionRoot);

  for (const nodeModulesRoot of nodeModulesSearchRoots(
    projectRoot,
    resolutionRoot
  )) {
    const packageDirectory = resolve(
      nodeModulesRoot,
      "@scribe-sdk",
      "cli"
    );
    const manifestPath = resolve(packageDirectory, "package.json");

    let source: string;
    try {
      source = await readFile(manifestPath, "utf8");
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) continue;
      throw new Error(
        `Could not read project-local Scribe CLI manifest ${manifestPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    let manifest: {
      readonly name?: unknown;
      readonly bin?: unknown;
      readonly version?: unknown;
    };
    try {
      manifest = JSON.parse(source) as typeof manifest;
    } catch (error) {
      throw new Error(
        `Could not parse project-local Scribe CLI manifest ${manifestPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (
      manifest.name !== undefined &&
      manifest.name !== "@scribe-sdk/cli"
    ) {
      throw new Error(
        `Resolved @scribe-sdk/cli to ${manifestPath}, but that manifest declares ${JSON.stringify(
          manifest.name
        )}.`
      );
    }

    const version = manifest.version;
    if (typeof version !== "string" || version.trim() === "") {
      throw new Error(
        `Project-local Scribe CLI at ${manifestPath} does not contain a valid version.`
      );
    }
    assertExactVersion(version, "project-local Scribe CLI");

    const bin = resolveCliBin(manifest.bin);
    if (bin === undefined) {
      throw new Error(
        `Project-local Scribe CLI at ${manifestPath} does not advertise a scribe/scb executable.`
      );
    }

    const canonicalPackageRoot = await realpath(packageDirectory).catch(
      (error: unknown) => {
        throw new Error(
          `Could not resolve project-local Scribe CLI package ${packageDirectory}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    );

    const requestedEntry = resolve(canonicalPackageRoot, bin);
    let canonicalEntry: string;
    try {
      canonicalEntry = await realpath(requestedEntry);
    } catch (error) {
      throw new Error(
        `Project-local Scribe CLI entry ${requestedEntry} does not resolve: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (!isWithin(canonicalEntry, canonicalPackageRoot)) {
      throw new Error(
        `Project-local Scribe CLI entry ${canonicalEntry} escapes its package root ${canonicalPackageRoot}.`
      );
    }

    return {
      packageRoot: canonicalPackageRoot,
      entry: canonicalEntry,
      version
    };
  }

  return undefined;
}

async function findLocalResolutionRoot(
  projectRoot: string
): Promise<ResolutionRoot> {
  try {
    const context = await detectPackageManagerContext(projectRoot);
    return {
      root: context.packageManagerRoot,
      packageManagerRoot: context.packageManagerRoot
    };
  } catch (error) {
    if (error instanceof PackageManagerDetectionError) {
      return { root: await findProjectSearchBoundary(projectRoot) };
    }
    throw error;
  }
}

async function classifyExecutionSource(
  flags: {
    readonly delegated: boolean;
    readonly samePackageRoot: boolean;
    readonly hasLocalCli: boolean;
  },
  cwd: string,
  packageRoot: string,
  resolutionRoot: string | undefined,
  workspaceDevelopment:
    | ((
        cwd: string,
        packageRoot: string,
        resolutionRoot?: string
      ) => Promise<boolean>)
    | undefined
): Promise<ExecutionSource> {
  if (flags.delegated) return "delegated-child";
  if (flags.samePackageRoot) return "project-local";
  if (flags.hasLocalCli) return "foreign-with-local";

  if (
    await (
      workspaceDevelopment ?? isWorkspaceDevelopment
    )(cwd, packageRoot, resolutionRoot)
  ) {
    return "workspace-development";
  }

  return "foreign-without-local";
}

async function isWorkspaceDevelopment(
  cwd: string,
  packageRoot: string,
  resolutionRoot?: string
): Promise<boolean> {
  const canonicalCwd = await canonicalOrResolved(cwd);
  const canonicalPackageRoot = await canonicalOrResolved(packageRoot);
  const boundary =
    resolutionRoot === undefined
      ? await findProjectSearchBoundary(canonicalCwd)
      : await canonicalOrResolved(resolutionRoot);

  if (!isWithin(canonicalPackageRoot, boundary)) return false;

  const manifestPath = resolve(canonicalPackageRoot, "package.json");
  let source: string;
  try {
    source = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw new Error(
      `Could not inspect Scribe workspace package ${manifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  let manifest: ProjectManifest;
  try {
    manifest = JSON.parse(source) as ProjectManifest;
  } catch (error) {
    throw new Error(
      `Could not parse Scribe workspace package ${manifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return manifest.name === "@scribe-sdk/cli";
}

async function spawnDelegate(
  command: string,
  args: readonly string[],
  options: DelegationOptions
): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...options.env } as NodeJS.ProcessEnv,
      stdio: "inherit",
      shell: false
    });

    let settled = false;

    const forward = (signal: NodeJS.Signals) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");

    const cleanup = () => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    child.once("error", (error) => {
      finish(() => reject(error));
    });

    child.once("exit", (code, signal) => {
      finish(() =>
        resolveStatus(
          code ??
            (signal === "SIGINT"
              ? 130
              : signal === "SIGTERM"
                ? 143
                : 1)
        )
      );
    });
  });
}

async function findProjectSearchBoundary(
  input: string
): Promise<string> {
  const start = await canonicalOrResolved(input);

  const gitBoundary = await findNearestAncestor(start, async (directory) => {
    try {
      return await pathExistsStrict(resolve(directory, ".git"));
    } catch {
      return false;
    }
  });
  if (gitBoundary !== undefined) return gitBoundary;

  const workspaceBoundary = await findNearestAncestor(
    start,
    isWorkspaceBoundary
  );
  if (workspaceBoundary !== undefined) return workspaceBoundary;

  const packageBoundary = await findNearestAncestor(start, async (directory) => {
    try {
      return await pathExistsStrict(resolve(directory, "package.json"));
    } catch {
      return false;
    }
  });
  return packageBoundary ?? start;
}

async function findNearestAncestor(
  start: string,
  predicate: (directory: string) => Promise<boolean>
): Promise<string | undefined> {
  let current = start;

  for (;;) {
    if (await predicate(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function isWorkspaceBoundary(directory: string): Promise<boolean> {
  try {
    if (await pathExistsStrict(resolve(directory, "pnpm-workspace.yaml"))) {
      return true;
    }
  } catch {
    // Ancestor probing is best-effort; the application root is validated separately.
  }

  const manifestPath = resolve(directory, "package.json");
  let source: string;

  try {
    source = await readFile(manifestPath, "utf8");
  } catch {
    return false;
  }

  let manifest: ProjectManifest;
  try {
    manifest = JSON.parse(source) as ProjectManifest;
  } catch {
    return false;
  }

  const value = manifest.workspaces;
  if (Array.isArray(value)) return true;
  return (
    value !== null &&
    typeof value === "object" &&
    "packages" in value &&
    Array.isArray(
      (value as { readonly packages?: unknown }).packages
    )
  );
}

function resolveCliBin(bin: unknown): string | undefined {
  if (typeof bin === "string" && bin.trim() !== "") return bin;

  if (bin !== null && typeof bin === "object") {
    const record = bin as Readonly<Record<string, unknown>>;
    const scribe = record.scribe;
    if (typeof scribe === "string" && scribe.trim() !== "") return scribe;

    const scb = record.scb;
    if (typeof scb === "string" && scb.trim() !== "") return scb;
  }

  return undefined;
}

function nodeModulesSearchRoots(
  projectRoot: string,
  resolutionRoot: string
): readonly string[] {
  const roots: string[] = [];
  let current = projectRoot;

  for (;;) {
    roots.push(resolve(current, "node_modules"));
    if (current === resolutionRoot) return roots;

    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `Resolution root ${resolutionRoot} is not an ancestor of project root ${projectRoot}.`
      );
    }
    current = parent;
  }
}

async function canonicalMarkerTarget(value: string): Promise<string> {
  const absolute = resolve(value);
  try {
    return await realpath(absolute);
  } catch {
    // A marker that does not resolve cannot prove delegation ownership.
    return absolute;
  }
}

async function canonicalOrResolved(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

async function pathExistsStrict(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw new Error(
      `Could not inspect ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function assertWithinBoundary(
  path: string,
  boundary: string
): void {
  if (!isWithin(path, boundary)) {
    throw new Error(`${path} is outside trusted boundary ${boundary}.`);
  }
}

function isWithin(path: string, boundary: string): boolean {
  const value = relative(boundary, path);
  return (
    value === "" ||
    (!isAbsolute(value) &&
      value !== ".." &&
      !value.startsWith(`..${sep}`))
  );
}

function assertExactVersion(version: string, subject: string): void {
  const normalized = version.trim();
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
      normalized
    )
  ) {
    throw new Error(
      `Expected ${subject} to have an exact semantic version, received ${JSON.stringify(
        version
      )}.`
    );
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}
