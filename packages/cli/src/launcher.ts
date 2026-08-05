import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const delegationMarker = "SCRIBE_DELEGATED";

export type InvokedBinary = "scribe" | "scb" | "other";
export type ExecutionSource = "project-local" | "user-level" | "ephemeral" | "workspace-development" | "delegated-child";

export interface LocalCli {
  readonly packageRoot: string;
  readonly entry: string;
  readonly version?: string;
}

export interface ExecutionContext {
  readonly cwd: string;
  readonly invokedBinary: InvokedBinary;
  readonly packageRoot: string;
  readonly packageVersion: string;
  readonly projectRoot?: string;
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
  readonly resolveLocal?: (projectRoot: string) => Promise<LocalCli | undefined>;
  readonly realpathImpl?: (path: string) => Promise<string>;
  readonly spawnImpl?: (command: string, args: readonly string[], options: DelegationOptions) => Promise<number>;
  readonly workspaceDevelopment?: (cwd: string, packageRoot: string) => Promise<boolean>;
}

export async function resolveExecutionContext(dependencies: LauncherDependencies = {}): Promise<ExecutionContext> {
  const cwd = dependencies.cwd ?? process.cwd();
  const argv1 = dependencies.argv1 ?? process.argv[1];
  const env = dependencies.env ?? process.env;
  const packageRoot = dependencies.packageRoot ?? resolveCliPackageRoot();
  const packageVersion = dependencies.packageVersion ?? readCliVersion(packageRoot);
  const delegated = delegationMarker in env;
  const invokedBinary = classifyInvokedBinary(argv1);
  const projectRoot = await (dependencies.findProjectRoot ?? findSupportedProjectRoot)(cwd);
  const localCli = projectRoot === undefined
    ? undefined
    : await (dependencies.resolveLocal ?? resolveLocalCli)(projectRoot);
  const samePackageRoot = localCli === undefined
    ? false
    : await (dependencies.realpathImpl ?? realpath)(localCli.packageRoot) === packageRoot;
  const source = await classifyExecutionSource(
    { delegated, samePackageRoot, localCli: localCli !== undefined },
    cwd,
    packageRoot,
    dependencies.workspaceDevelopment
  );
  return {
    cwd,
    invokedBinary,
    packageRoot,
    packageVersion,
    ...(projectRoot === undefined ? {} : { projectRoot }),
    ...(localCli === undefined ? {} : { localCli }),
    delegated,
    source
  };
}

export async function shouldDelegate(context: ExecutionContext): Promise<boolean> {
  return !context.delegated
    && context.projectRoot !== undefined
    && context.localCli !== undefined
    && context.localCli.packageRoot !== context.packageRoot;
}

export async function delegateToLocalCli(
  context: ExecutionContext,
  args: readonly string[],
  dependencies: { readonly env?: Readonly<Record<string, string | undefined>>; readonly spawnImpl?: (command: string, args: readonly string[], options: DelegationOptions) => Promise<number> } = {}
): Promise<number> {
  const localCli = context.localCli;
  if (localCli === undefined) throw new Error("Cannot delegate without a resolved project-local CLI.");
  const spawnImpl = dependencies.spawnImpl ?? spawnDelegate;
  return spawnImpl(process.execPath, [localCli.entry, ...args], {
    cwd: context.cwd,
    env: { ...(dependencies.env ?? process.env), [delegationMarker]: "1" }
  });
}

export function classifyInvokedBinary(argv1: string | undefined): InvokedBinary {
  if (argv1 === undefined) return "other";
  const name = argv1.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase().replace(/\.(?:exe|cmd|js|mjs|cjs)$/u, "");
  if (name === "scribe") return "scribe";
  if (name === "scb") return "scb";
  return "other";
}

export function resolveCliPackageRoot(): string {
  return realpathSync(dirname(fileURLToPath(new URL("../package.json", import.meta.url))));
}

export function readCliVersion(packageRoot: string): string {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as { readonly version?: string };
  return typeof manifest.version === "string" ? manifest.version : "0.0.0";
}

export async function findSupportedProjectRoot(cwd: string): Promise<string | undefined> {
  let current = resolve(cwd);
  for (;;) {
    if (await isSupportedProject(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function isSupportedProject(directory: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8")) as {
      readonly dependencies?: Readonly<Record<string, string>>;
      readonly devDependencies?: Readonly<Record<string, string>>;
    };
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    return dependencies.react !== undefined && (dependencies.next !== undefined || dependencies.vite !== undefined);
  } catch {
    return false;
  }
}

export async function resolveLocalCli(projectRoot: string): Promise<LocalCli | undefined> {
  const packageDirectory = resolve(projectRoot, "node_modules", "@scribe-sdk", "cli");
  let manifest: { readonly bin?: Readonly<Record<string, string>>; readonly version?: string };
  try {
    manifest = JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8")) as typeof manifest;
  } catch {
    return undefined;
  }
  const bin = manifest.bin?.scribe ?? manifest.bin?.scb;
  const entry = resolve(packageDirectory, typeof bin === "string" ? bin : "./dist/index.mjs");
  const packageRoot = await safeRealpath(packageDirectory);
  const entryPath = await safeRealpath(entry);
  if (packageRoot === undefined || entryPath === undefined) return undefined;
  if (entryPath !== packageRoot && !entryPath.startsWith(packageRoot + sep)) return undefined;
  return {
    packageRoot,
    entry: entryPath,
    ...(typeof manifest.version === "string" ? { version: manifest.version } : {})
  };
}

async function classifyExecutionSource(
  flags: { readonly delegated: boolean; readonly samePackageRoot: boolean; readonly localCli: boolean },
  cwd: string,
  packageRoot: string,
  workspaceDevelopment: ((cwd: string, packageRoot: string) => Promise<boolean>) | undefined
): Promise<ExecutionSource> {
  if (flags.delegated) return "delegated-child";
  if (flags.samePackageRoot) return "project-local";
  if (flags.localCli) return "user-level";
  if (await (workspaceDevelopment ?? isWorkspaceDevelopment)(cwd, packageRoot)) return "workspace-development";
  return "ephemeral";
}

async function isWorkspaceDevelopment(cwd: string, packageRoot: string): Promise<boolean> {
  let current = resolve(cwd);
  for (;;) {
    const local = await resolveLocalCli(current);
    if (local !== undefined) {
      try {
        if ((await realpath(local.packageRoot)) === packageRoot) return true;
      } catch {
        // Continue walking toward the repository root.
      }
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function spawnDelegate(command: string, args: readonly string[], options: DelegationOptions): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...options.env } as NodeJS.ProcessEnv,
      stdio: "inherit",
      shell: false
    });
    const forwardSignal = (signal: NodeJS.Signals) => {
      if (!child.killed) child.kill(signal);
    };
    const cleanup = () => {
      process.removeListener("SIGINT", forwardSignal);
      process.removeListener("SIGTERM", forwardSignal);
    };
    process.once("SIGINT", forwardSignal);
    process.once("SIGTERM", forwardSignal);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolveStatus(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1));
    });
  });
}

async function safeRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}
