import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";
export type AutomatedPackageManager = "bun" | "npm";

/** @deprecated Prefer AutomatedPackageManager. */
export type SupportedPackageManager = AutomatedPackageManager;

export type PackageManagerDetectionErrorCode =
  | "unknown-package-manager"
  | "conflicting-package-manager-signals"
  | "invalid-package-manager-declaration"
  | "package-manager-inspection-failed";

export interface PackageManagerDeclaration {
  readonly manager: PackageManager;
  readonly raw: string;
  readonly path: string;
  readonly version?: string;
}

export interface PackageManagerLockfile {
  readonly manager: PackageManager;
  readonly filename: string;
  readonly path: string;
}

export interface PackageManagerContext {
  readonly applicationRoot: string;
  readonly packageManagerRoot: string;
  readonly manager: PackageManager;
  readonly declarations: readonly PackageManagerDeclaration[];
  readonly lockfiles: readonly PackageManagerLockfile[];
}

export interface PackageCommand {
  readonly executable: PackageManager;
  readonly args: readonly string[];
}

export class PackageManagerDetectionError extends Error {
  readonly code: PackageManagerDetectionErrorCode;
  readonly applicationRoot: string;

  constructor(code: PackageManagerDetectionErrorCode, applicationRoot: string, message: string) {
    super(message);
    this.name = "PackageManagerDetectionError";
    this.code = code;
    this.applicationRoot = applicationRoot;
  }
}

const lockfileDefinitions = [
  { filename: "bun.lock", manager: "bun" },
  { filename: "bun.lockb", manager: "bun" },
  { filename: "pnpm-lock.yaml", manager: "pnpm" },
  { filename: "yarn.lock", manager: "yarn" },
  { filename: "package-lock.json", manager: "npm" },
  { filename: "npm-shrinkwrap.json", manager: "npm" }
] as const satisfies readonly { readonly filename: string; readonly manager: PackageManager }[];

const scribeRuntimePackages = ["@scribe-sdk/react", "@scribe-sdk/styles", "@scribe-sdk/mdx"] as const;
const scribeCliPackage = "@scribe-sdk/cli" as const;

interface PackageManifest {
  readonly packageManager?: unknown;
  readonly workspaces?: unknown;
}

interface DirectoryInspection {
  readonly root: string;
  readonly declaration?: PackageManagerDeclaration;
  readonly lockfiles: readonly PackageManagerLockfile[];
  readonly workspaceMarker: boolean;
}

/**
 * Compatibility helper for callers that only need the resolved manager.
 * New orchestration code should use detectPackageManagerContext() so the
 * package-manager root is not confused with the application root.
 */
export async function detectPackageManager(root: string, declaration?: string): Promise<PackageManager> {
  return (await detectPackageManagerContext(root, declaration)).manager;
}

export async function detectPackageManagerContext(
  inputApplicationRoot: string,
  suppliedApplicationDeclaration?: string
): Promise<PackageManagerContext> {
  const applicationRoot = await canonicalDirectory(inputApplicationRoot);
  const application = await inspectDirectory(applicationRoot, suppliedApplicationDeclaration);

  let packageManagerRoot = applicationRoot;
  let packageManagerInspection = application;

  if (application.lockfiles.length === 0) {
    const boundary = await findSearchBoundary(applicationRoot);
    const ancestorWithLockfile = boundary === applicationRoot
      ? undefined
      : await findNearestWorkspaceEvidence(applicationRoot, boundary, "lockfile");

    if (ancestorWithLockfile !== undefined) {
      packageManagerRoot = ancestorWithLockfile.root;
      packageManagerInspection = ancestorWithLockfile;
    } else if (application.declaration === undefined) {
      const ancestorWithDeclaration = boundary === applicationRoot
        ? undefined
        : await findNearestWorkspaceEvidence(applicationRoot, boundary, "declaration");

      if (ancestorWithDeclaration !== undefined) {
        packageManagerRoot = ancestorWithDeclaration.root;
        packageManagerInspection = ancestorWithDeclaration;
      }
    }
  }

  const chain = await inspectChain(applicationRoot, packageManagerRoot, suppliedApplicationDeclaration);
  const declarations = chain.flatMap((entry) => entry.declaration === undefined ? [] : [entry.declaration]);
  const lockfiles = packageManagerInspection.lockfiles;

  const declarationManagers = new Set(declarations.map((entry) => entry.manager));
  const lockfileManagers = new Set(lockfiles.map((entry) => entry.manager));

  if (declarationManagers.size > 1) {
    throw conflictError(
      applicationRoot,
      `Conflicting packageManager declarations were found between the application and package-manager root: ${formatDeclarations(declarations)}.`
    );
  }

  if (lockfileManagers.size > 1) {
    throw conflictError(
      applicationRoot,
      `Conflicting package-manager lockfiles exist in ${packageManagerRoot}: ${lockfiles.map((entry) => entry.filename).join(", ")}. Remove stale lockfiles before Scribe mutates dependencies.`
    );
  }

  const declaredManager = declarationManagers.values().next().value as PackageManager | undefined;
  const lockfileManager = lockfileManagers.values().next().value as PackageManager | undefined;

  if (declaredManager !== undefined && lockfileManager !== undefined && declaredManager !== lockfileManager) {
    throw conflictError(
      applicationRoot,
      `The declared package manager (${declaredManager}) disagrees with the lockfile in ${packageManagerRoot} (${lockfileManager}). Scribe will not guess which one should mutate the project.`
    );
  }

  const manager = lockfileManager ?? declaredManager;
  if (manager === undefined) {
    throw new PackageManagerDetectionError(
      "unknown-package-manager",
      applicationRoot,
      "Could not determine the package manager. No supported lockfile or packageManager declaration was found at the application root or a containing workspace root; Scribe will not default to npm."
    );
  }

  return {
    applicationRoot,
    packageManagerRoot,
    manager,
    declarations,
    lockfiles
  };
}

export function isAutomatedPackageManager(manager: PackageManager): manager is AutomatedPackageManager {
  return manager === "bun" || manager === "npm";
}

/** @deprecated Prefer isAutomatedPackageManager(). */
export function isSupportedPackageManager(manager: PackageManager): manager is SupportedPackageManager {
  return isAutomatedPackageManager(manager);
}

export function installCommand(
  manager: PackageManager,
  packages: readonly string[],
  development: boolean
): PackageCommand {
  assertPackages(packages, "install");

  if (manager === "bun") {
    return command("bun", ["add", "--exact", ...(development ? ["--dev"] : []), ...packages]);
  }
  if (manager === "pnpm") {
    return command("pnpm", ["add", "--save-exact", ...(development ? ["-D"] : []), ...packages]);
  }
  if (manager === "yarn") {
    return command("yarn", ["add", "--exact", ...(development ? ["-D"] : []), ...packages]);
  }
  return command("npm", ["install", "--save-exact", ...(development ? ["--save-dev"] : []), ...packages]);
}

export function removeCommand(manager: PackageManager, packages: readonly string[]): PackageCommand {
  assertPackages(packages, "remove");

  if (manager === "bun") return command("bun", ["remove", ...packages]);
  if (manager === "pnpm") return command("pnpm", ["remove", ...packages]);
  if (manager === "yarn") return command("yarn", ["remove", ...packages]);
  return command("npm", ["uninstall", ...packages]);
}

/**
 * Converges the complete Scribe package set to one exact version while
 * preserving runtime-vs-dev dependency placement.
 */
export function scribeConvergenceCommands(manager: PackageManager, expected: string): readonly PackageCommand[] {
  assertExactVersion(expected);
  return [
    installCommand(manager, scribeRuntimePackages.map((name) => `${name}@${expected}`), false),
    installCommand(manager, [`${scribeCliPackage}@${expected}`], true)
  ];
}

/** @deprecated Prefer scribeConvergenceCommands(). */
export function updateCommand(manager: PackageManager, expected: string): readonly PackageCommand[] {
  return scribeConvergenceCommands(manager, expected);
}

export function formatPackageCommand(value: PackageCommand): string {
  return [value.executable, ...value.args].map(shellDisplayArgument).join(" ");
}

export async function runPackageCommand(
  value: PackageCommand,
  cwd: string
): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const protocolMode = process.env.SCRIBE_ENGINE_PROTOCOL === "1";
    const child = spawn(value.executable, [...value.args], {
      cwd,
      stdio: protocolMode ? ["inherit", "pipe", "pipe"] : "inherit",
      shell: false
    });
    if (protocolMode) {
      child.stdout?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
      child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    }
    let settled = false;
    const forward = (signal: NodeJS.Signals) => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
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
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => finish(() => resolveStatus(
      code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)
    )));
  });
}

async function inspectDirectory(root: string, suppliedDeclaration?: string): Promise<DirectoryInspection> {
  const manifestPath = resolve(root, "package.json");
  const manifest = await readManifestIfPresent(manifestPath);
  const rawDeclaration = suppliedDeclaration ?? manifest?.packageManager;
  const declaration = rawDeclaration === undefined
    ? undefined
    : parseDeclaration(rawDeclaration, manifestPath, root);

  const lockfiles: PackageManagerLockfile[] = [];
  for (const definition of lockfileDefinitions) {
    const path = resolve(root, definition.filename);
    if (await pathExistsStrict(path, root)) {
      lockfiles.push({ manager: definition.manager, filename: definition.filename, path });
    }
  }

  const workspaceMarker = manifestHasWorkspaces(manifest) || await pathExistsStrict(resolve(root, "pnpm-workspace.yaml"), root);
  return {
    root,
    ...(declaration === undefined ? {} : { declaration }),
    lockfiles,
    workspaceMarker
  };
}

async function inspectChain(
  applicationRoot: string,
  packageManagerRoot: string,
  suppliedApplicationDeclaration?: string
): Promise<readonly DirectoryInspection[]> {
  const chain: DirectoryInspection[] = [];
  let current = applicationRoot;

  for (;;) {
    const strictBoundary =
      current === applicationRoot || current === packageManagerRoot;
    try {
      chain.push(
        await inspectDirectory(
          current,
          current === applicationRoot
            ? suppliedApplicationDeclaration
            : undefined
        )
      );
    } catch (error) {
      if (
        strictBoundary ||
        !(error instanceof PackageManagerDetectionError)
      ) {
        throw error;
      }
    }
    if (current === packageManagerRoot) return chain;
    const parent = dirname(current);
    if (parent === current) {
      throw new PackageManagerDetectionError(
        "package-manager-inspection-failed",
        applicationRoot,
        `Package-manager root ${packageManagerRoot} is not an ancestor of application root ${applicationRoot}.`
      );
    }
    current = parent;
  }
}

async function findNearestWorkspaceEvidence(
  applicationRoot: string,
  boundary: string,
  kind: "lockfile" | "declaration"
): Promise<DirectoryInspection | undefined> {
  let current = dirname(applicationRoot);

  for (;;) {
    let inspection: DirectoryInspection | undefined;
    try {
      inspection = await inspectDirectory(current);
    } catch (error) {
      if (!(error instanceof PackageManagerDetectionError)) throw error;
    }

    const hasRequestedEvidence = inspection === undefined
      ? false
      : kind === "lockfile"
        ? inspection.lockfiles.length > 0
        : inspection.declaration !== undefined;

    // An ancestor may own dependency mutations only when it explicitly looks
    // like a workspace boundary. This prevents inheriting random lockfiles
    // from unrelated parent directories such as the user's home directory.
    if (inspection?.workspaceMarker && hasRequestedEvidence) return inspection;

    if (current === boundary) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function findSearchBoundary(applicationRoot: string): Promise<string> {
  let current = applicationRoot;

  for (;;) {
    try {
      if (await pathExistsStrict(resolve(current, ".git"), applicationRoot)) {
        return current;
      }
    } catch (error) {
      if (!(error instanceof PackageManagerDetectionError)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  current = dirname(applicationRoot);
  for (;;) {
    try {
      const inspection = await inspectDirectory(current);
      if (inspection.workspaceMarker) return current;
    } catch (error) {
      if (!(error instanceof PackageManagerDetectionError)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return applicationRoot;
    current = parent;
  }
}

function parseDeclaration(value: unknown, manifestPath: string, applicationRoot: string): PackageManagerDeclaration {
  if (typeof value !== "string") {
    throw new PackageManagerDetectionError(
      "invalid-package-manager-declaration",
      applicationRoot,
      `The packageManager field in ${manifestPath} must be a string.`
    );
  }

  const raw = value.trim();
  const match = /^(bun|npm|pnpm|yarn)(?:@(.+))?$/u.exec(raw);
  if (match === null) {
    throw new PackageManagerDetectionError(
      "invalid-package-manager-declaration",
      applicationRoot,
      `Unsupported or malformed packageManager declaration ${JSON.stringify(value)} in ${manifestPath}. Expected bun, npm, pnpm, or yarn with an optional version.`
    );
  }

  const manager = match[1] as PackageManager;
  const version = match[2]?.trim();
  if (match[2] !== undefined && version === "") {
    throw new PackageManagerDetectionError(
      "invalid-package-manager-declaration",
      applicationRoot,
      `Malformed packageManager declaration ${JSON.stringify(value)} in ${manifestPath}.`
    );
  }

  return {
    manager,
    raw,
    path: manifestPath,
    ...(version === undefined ? {} : { version })
  };
}

async function readManifestIfPresent(path: string): Promise<PackageManifest | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw new PackageManagerDetectionError(
      "package-manager-inspection-failed",
      dirname(path),
      `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    return JSON.parse(source) as PackageManifest;
  } catch (error) {
    throw new PackageManagerDetectionError(
      "package-manager-inspection-failed",
      dirname(path),
      `Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function manifestHasWorkspaces(manifest: PackageManifest | undefined): boolean {
  if (manifest === undefined) return false;
  const value = manifest.workspaces;
  if (Array.isArray(value)) return true;
  if (value !== null && typeof value === "object" && "packages" in value) {
    return Array.isArray((value as { readonly packages?: unknown }).packages);
  }
  return false;
}

async function canonicalDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    throw new PackageManagerDetectionError(
      "package-manager-inspection-failed",
      absolute,
      `Could not resolve application root ${absolute}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function pathExistsStrict(path: string, applicationRoot: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw new PackageManagerDetectionError(
      "package-manager-inspection-failed",
      applicationRoot,
      `Could not inspect ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function conflictError(applicationRoot: string, message: string): PackageManagerDetectionError {
  return new PackageManagerDetectionError("conflicting-package-manager-signals", applicationRoot, message);
}

function formatDeclarations(declarations: readonly PackageManagerDeclaration[]): string {
  return declarations.map((entry) => `${entry.raw} in ${entry.path}`).join(", ");
}

function command(executable: PackageManager, args: readonly string[]): PackageCommand {
  return { executable, args };
}

function assertPackages(packages: readonly string[], operation: string): void {
  if (packages.length === 0) throw new Error(`Cannot ${operation} zero packages.`);
  if (packages.some((value) => value.trim() === "")) throw new Error(`Cannot ${operation} an empty package specifier.`);
}

function assertExactVersion(version: string): void {
  const normalized = version.trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(normalized)) {
    throw new Error(`Expected an exact Scribe version, received ${JSON.stringify(version)}.`);
  }
}

function shellDisplayArgument(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === code;
}
