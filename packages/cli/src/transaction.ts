import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export const integrationLockFilename = ".scribe-integrate.lock";

export interface SnapshotEntry {
  readonly existed: boolean;
  readonly content?: string;
}

export interface AppliedChange {
  readonly path: string;
  readonly created: boolean;
}

export class IntegrationLockError extends Error {
  readonly owner: string | undefined;
  constructor(owner: string | undefined) {
    super(owner === undefined ? "Another Scribe integration is in progress." : `Another Scribe integration is in progress (PID ${owner}).`);
    this.name = "IntegrationLockError";
    this.owner = owner;
  }
}

export class FileTransactionError extends Error {
  readonly written: readonly AppliedChange[];
  readonly failedPath: string;
  constructor(message: string, written: readonly AppliedChange[], failedPath: string) {
    super(message);
    this.name = "FileTransactionError";
    this.written = written;
    this.failedPath = failedPath;
  }
}

interface LockRecord {
  readonly pid: number;
  readonly startedAt: number;
}

export async function acquireIntegrationLock(root: string): Promise<string> {
  const lockPath = resolve(root, integrationLockFilename);
  const record: LockRecord = { pid: process.pid, startedAt: Date.now() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
      return lockPath;
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
      const existing = await readLockRecord(lockPath);
      if (existing !== undefined && isProcessAlive(existing.pid)) {
        throw new IntegrationLockError(String(existing.pid));
      }
      await unlink(lockPath).catch(() => undefined);
    }
  }
  throw new IntegrationLockError(undefined);
}

export async function releaseIntegrationLock(lockPath: string): Promise<void> {
  await unlink(lockPath).catch(() => undefined);
}

export async function snapshotFiles(root: string, paths: readonly string[]): Promise<Map<string, SnapshotEntry>> {
  const snapshot = new Map<string, SnapshotEntry>();
  for (const relativePath of paths) {
    const absolute = resolve(root, relativePath);
    try {
      snapshot.set(relativePath, { existed: true, content: await readFile(absolute, "utf8") });
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
      snapshot.set(relativePath, { existed: false });
    }
  }
  return snapshot;
}

export async function applyFileChanges(
  root: string,
  changes: readonly { readonly path: string; readonly content: string }[]
): Promise<readonly AppliedChange[]> {
  const written: AppliedChange[] = [];
  for (const change of changes) {
    const absolute = resolve(root, change.path);
    const existed = await pathExists(absolute);
    try {
      await atomicWrite(absolute, change.content);
    } catch (error) {
      throw new FileTransactionError(
        `Could not apply the reported Scribe change ${change.path}: ${error instanceof Error ? error.message : String(error)}`,
        written,
        change.path
      );
    }
    written.push({ path: change.path, created: !existed });
  }
  return written;
}

export async function restoreSnapshot(
  root: string,
  snapshot: ReadonlyMap<string, SnapshotEntry>,
  created: readonly string[]
): Promise<readonly string[]> {
  const createdSet = new Set(created);
  const failures: string[] = [];
  for (const [relativePath, entry] of snapshot) {
    const absolute = resolve(root, relativePath);
    try {
      if (entry.existed && entry.content !== undefined) {
        await atomicWrite(absolute, entry.content);
      } else if (createdSet.has(relativePath)) {
        await rm(absolute, { force: true });
      }
    } catch {
      failures.push(relativePath);
    }
  }
  return failures;
}

export interface VerifyOptions {
  readonly packages?: readonly { readonly name: string; readonly version: string }[];
  readonly stylesheetMode?: string;
  readonly files: readonly { readonly path: string; readonly created: boolean }[];
}

export async function verifyIntegration(root: string, options: VerifyOptions): Promise<readonly string[]> {
  const problems: string[] = [];
  for (const target of options.packages ?? []) {
    const version = await installedPackageVersion(root, target.name);
    if (version === undefined) {
      problems.push(`Package ${target.name}@${target.version} did not resolve after installation.`);
    } else if (version !== target.version) {
      problems.push(`Package ${target.name} resolved at ${version}; expected ${target.version}.`);
    }
  }
  if (options.stylesheetMode !== undefined && (await installedPackageVersion(root, "@scribe-sdk/styles")) !== undefined) {
    const stylesheet = resolve(root, "node_modules", "@scribe-sdk", "styles", `${options.stylesheetMode}.css`);
    if (!(await pathExists(stylesheet))) {
      problems.push(`The selected stylesheet @scribe-sdk/styles/${options.stylesheetMode}.css was not installed.`);
    }
  }
  for (const file of options.files) {
    const absolute = resolve(root, file.path);
    if (!(await pathExists(absolute))) {
      problems.push(`The reported file ${file.path} was not written.`);
    }
  }
  return problems;
}

export function manifestAndLockfilePaths(root: string, manager: "bun" | "npm"): string[] {
  const lockfiles = manager === "bun" ? ["bun.lock", "bun.lockb"] : ["package-lock.json"];
  return ["package.json", ...lockfiles].map((name) => resolve(root, name));
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = resolve(
    dirname(path),
    `.${basename(path)}.scribe-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`
  );
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readLockRecord(lockPath: string): Promise<LockRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockRecord>;
    return typeof parsed.pid === "number" ? { pid: parsed.pid, startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0 } : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isFileSystemError(error, "EPERM");
  }
}

async function installedPackageVersion(root: string, name: string): Promise<string | undefined> {
  try {
    const segments = name.split("/").filter(Boolean);
    const manifest = JSON.parse(
      await readFile(resolve(root, "node_modules", ...segments, "package.json"), "utf8")
    ) as { readonly version?: string };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === code;
}
