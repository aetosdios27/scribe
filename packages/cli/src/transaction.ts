import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const integrationLockFilename = ".scribe-integrate.lock";
const integrationLockCleanupFilename = ".scribe-integrate.lock.cleanup";

export interface IntegrationLockHandle {
  readonly path: string;
  readonly token: string;
}

export interface SnapshotEntry {
  readonly existed: boolean;
  readonly content?: Buffer;
  readonly mode?: number;
}

export interface AppliedChange {
  readonly path: string;
  readonly created: boolean;
  readonly writtenHash: string;
}

export type ExpectedFileState =
  | { readonly kind: "missing" }
  | { readonly kind: "file"; readonly hash: string };

export interface FileChange {
  readonly path: string;
  readonly content: string | Buffer;
  readonly expected: ExpectedFileState;
}

export class IntegrationLockError extends Error {
  readonly ownerPid: number | undefined;

  constructor(ownerPid: number | undefined, message?: string) {
    super(message ?? (
      ownerPid === undefined
        ? "Another Scribe integration is in progress."
        : `Another Scribe integration is in progress (PID ${ownerPid}).`
    ));
    this.name = "IntegrationLockError";
    this.ownerPid = ownerPid;
  }
}

export class IntegrationLockOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationLockOwnershipError";
  }
}

export class FileStateConflictError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`The project changed after the Scribe integration plan was created: ${path}. No file changes were applied; review the new state and run integrate again.`);
    this.name = "FileStateConflictError";
    this.path = path;
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
  readonly token: string;
}

interface LockReadResult {
  readonly record?: LockRecord;
  readonly malformed: boolean;
}

export async function acquireIntegrationLock(root: string): Promise<IntegrationLockHandle> {
  const canonicalRoot = await realpath(root);
  const lockPath = resolve(canonicalRoot, integrationLockFilename);

  for (;;) {
    const token = randomUUID();
    const record: LockRecord = { pid: process.pid, startedAt: Date.now(), token };
    const temporary = resolve(canonicalRoot, `.${integrationLockFilename}.${token}.tmp`);

    await writeDurableExclusiveFile(temporary, Buffer.from(JSON.stringify(record), "utf8"));

    try {
      await link(temporary, lockPath);
      await unlink(temporary).catch(() => undefined);
      await syncDirectory(canonicalRoot);
      return { path: lockPath, token };
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      if (!isFileSystemError(error, "EEXIST")) throw error;
    }

    const existing = await readLockRecord(lockPath);
    if (existing.record === undefined && !existing.malformed) {
      continue;
    }
    if (existing.malformed || existing.record === undefined) {
      throw new IntegrationLockError(
        undefined,
        "A Scribe integration lock exists but its ownership record is unreadable. Refusing to remove it automatically; if no Scribe integration is running, remove .scribe-integrate.lock manually and retry."
      );
    }

    if (isProcessAlive(existing.record.pid)) {
      throw new IntegrationLockError(existing.record.pid);
    }

    await recoverStaleLock(canonicalRoot, lockPath, existing.record);
  }
}

export async function releaseIntegrationLock(handle: IntegrationLockHandle): Promise<void> {
  const existing = await readLockRecord(handle.path);
  if (existing.record === undefined && !existing.malformed) return;
  if (existing.record === undefined || existing.malformed) {
    throw new IntegrationLockOwnershipError(
      `Could not verify ownership of ${handle.path}; refusing to remove a lock that may belong to another Scribe process.`
    );
  }
  if (existing.record.token !== handle.token || existing.record.pid !== process.pid) {
    throw new IntegrationLockOwnershipError(
      `Refusing to release ${handle.path} because its ownership changed.`
    );
  }

  try {
    await unlink(handle.path);
    await syncDirectory(dirname(handle.path));
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }
}

export async function captureExpectedFileState(root: string, path: string): Promise<ExpectedFileState> {
  const absolute = await resolveSafeProjectPath(root, path);
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to inspect symbolic-link transaction target ${path}.`);
    }
    if (!info.isFile()) {
      throw new Error(`Transaction target ${path} is not a regular file.`);
    }
    return { kind: "file", hash: hashBytes(await readFile(absolute)) };
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return { kind: "missing" };
    throw error;
  }
}

export async function assertExpectedFileStates(
  root: string,
  expectations: readonly { readonly path: string; readonly expected: ExpectedFileState }[]
): Promise<void> {
  const seen = new Set<string>();
  for (const expectation of expectations) {
    const normalized = normalizeRelativeProjectPath(expectation.path);
    if (seen.has(normalized)) throw new Error(`Duplicate transaction target: ${normalized}`);
    seen.add(normalized);
    const current = await captureExpectedFileState(root, normalized);
    if (!sameExpectedState(current, expectation.expected)) {
      throw new FileStateConflictError(normalized);
    }
  }
}

export async function snapshotFiles(root: string, paths: readonly string[]): Promise<Map<string, SnapshotEntry>> {
  const snapshot = new Map<string, SnapshotEntry>();
  for (const input of paths) {
    const path = normalizeRelativeProjectPath(input);
    if (snapshot.has(path)) continue;
    const absolute = await resolveSafeProjectPath(root, path);
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Refusing to snapshot symbolic-link transaction target ${path}.`);
      if (!info.isFile()) throw new Error(`Transaction snapshot target ${path} is not a regular file.`);
      snapshot.set(path, {
        existed: true,
        content: await readFile(absolute),
        mode: info.mode & 0o7777
      });
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
      snapshot.set(path, { existed: false });
    }
  }
  return snapshot;
}

export async function applyFileChanges(root: string, changes: readonly FileChange[]): Promise<readonly AppliedChange[]> {
  await assertExpectedFileStates(root, changes);

  const written: AppliedChange[] = [];
  for (const change of changes) {
    const path = normalizeRelativeProjectPath(change.path);
    const absolute = await resolveSafeProjectPath(root, path);
    const before = await captureExpectedFileState(root, path);
    if (!sameExpectedState(before, change.expected)) {
      if (written.length === 0) throw new FileStateConflictError(path);
      throw new FileTransactionError(
        `The project changed while Scribe was applying the integration plan: ${path}.`,
        written,
        path
      );
    }

    const mode = before.kind === "file" ? (await lstat(absolute)).mode & 0o7777 : undefined;
    const content = toBuffer(change.content);
    try {
      await atomicWrite(absolute, content, mode);
    } catch (error) {
      throw new FileTransactionError(
        `Could not apply the reported Scribe change ${path}: ${error instanceof Error ? error.message : String(error)}`,
        written,
        path
      );
    }
    written.push({ path, created: before.kind === "missing", writtenHash: hashBytes(content) });
  }
  return written;
}

export async function restoreSnapshot(
  root: string,
  snapshot: ReadonlyMap<string, SnapshotEntry>,
  applied: readonly AppliedChange[] = []
): Promise<readonly string[]> {
  const appliedByPath = new Map(applied.map((change) => [normalizeRelativeProjectPath(change.path), change]));
  const failures: string[] = [];

  for (const [input, entry] of snapshot) {
    const path = normalizeRelativeProjectPath(input);
    try {
      const absolute = await resolveSafeProjectPath(root, path);
      const appliedChange = appliedByPath.get(path);

      if (appliedChange !== undefined && await pathExists(absolute)) {
        const current = await readRegularFile(absolute, path);
        if (hashBytes(current) !== appliedChange.writtenHash) {
          failures.push(path);
          continue;
        }
      }

      if (entry.existed) {
        if (entry.content === undefined) throw new Error(`Snapshot for ${path} is missing its content.`);
        await atomicWrite(absolute, entry.content, entry.mode);
      } else {
        await rm(absolute, { force: true });
      }
    } catch {
      failures.push(path);
    }
  }

  return failures;
}

export async function observeTrackedMutations(
  root: string,
  snapshot: ReadonlyMap<string, SnapshotEntry>,
  paths: readonly string[]
): Promise<readonly AppliedChange[]> {
  const observed: AppliedChange[] = [];
  for (const path of paths) {
    const before = snapshot.get(path);
    if (before === undefined) continue;
    const current = await captureExpectedFileState(root, path);
    if (current.kind !== "file") continue;
    const beforeHash = before.existed && before.content !== undefined
      ? hashContent(before.content)
      : undefined;
    if (!before.existed || beforeHash !== current.hash) {
      observed.push({
        path,
        created: !before.existed,
        writtenHash: current.hash
      });
    }
  }
  return observed;
}

export function mergeAppliedChanges(
  ...groups: readonly (readonly AppliedChange[])[]
): readonly AppliedChange[] {
  const merged = new Map<string, AppliedChange>();
  for (const group of groups) {
    for (const change of group) merged.set(change.path, change);
  }
  return [...merged.values()];
}

export interface VerifyOptions {
  readonly files: readonly { readonly path: string; readonly expectedHash: string }[];
  readonly packages?: readonly {
    readonly name: string;
    readonly version: string;
    readonly manifestPath: string;
  }[];
  readonly stylesheet?: {
    readonly packageDirectory: string;
    readonly mode: string;
  };
}

export async function verifyIntegration(root: string, options: VerifyOptions): Promise<readonly string[]> {
  const problems: string[] = [];

  for (const target of options.packages ?? []) {
    try {
      const manifestPath = normalizeRelativeProjectPath(target.manifestPath);
      const absolute = await resolveSafeProjectPath(root, manifestPath);
      const manifest = JSON.parse(await readFile(absolute, "utf8")) as { readonly version?: string };
      if (manifest.version !== target.version) {
        problems.push(`Package ${target.name} resolved at ${String(manifest.version)}; expected ${target.version}.`);
      }
    } catch (error) {
      problems.push(`Could not verify package ${target.name}@${target.version}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (options.stylesheet !== undefined) {
    try {
      const packageDirectory = normalizeRelativeProjectPath(options.stylesheet.packageDirectory);
      const stylesheet = `${packageDirectory}/${options.stylesheet.mode}.css`;
      const absolute = await resolveSafeProjectPath(root, stylesheet);
      const info = await lstat(absolute);
      if (!info.isFile()) problems.push(`The selected stylesheet ${stylesheet} is not a regular file.`);
    } catch (error) {
      problems.push(`The selected stylesheet was not installed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const file of options.files) {
    try {
      const path = normalizeRelativeProjectPath(file.path);
      const absolute = await resolveSafeProjectPath(root, path);
      const content = await readRegularFile(absolute, path);
      const actualHash = hashBytes(content);
      if (actualHash !== file.expectedHash) {
        problems.push(`The reported file ${path} does not contain the content Scribe wrote.`);
      }
    } catch (error) {
      problems.push(`Could not verify the reported file ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return problems;
}

export function manifestAndLockfilePaths(applicationManifestPath: string, manager: "bun" | "npm"): string[] {
  const manifest = normalizeRelativeProjectPath(applicationManifestPath);
  const lockfiles = manager === "bun"
    ? ["bun.lock", "bun.lockb"]
    : ["package-lock.json", "npm-shrinkwrap.json"];
  return [manifest, ...lockfiles];
}

export function hashContent(content: string | Buffer): string {
  return hashBytes(toBuffer(content));
}

export async function atomicWrite(path: string, content: string | Buffer, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = resolve(dirname(path), `.${basename(path)}.scribe-${process.pid}-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode ?? 0o666);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function recoverStaleLock(root: string, lockPath: string, stale: LockRecord): Promise<void> {
  const cleanupPath = resolve(root, integrationLockCleanupFilename);
  let cleanupHandle: Awaited<ReturnType<typeof open>> | undefined;

  for (;;) {
    try {
      cleanupHandle = await open(cleanupPath, "wx", 0o600);
      await cleanupHandle.writeFile(`${process.pid}\n`, "utf8");
      await cleanupHandle.sync();
      break;
    } catch (error) {
      if (cleanupHandle !== undefined) {
        await cleanupHandle.close().catch(() => undefined);
        cleanupHandle = undefined;
        await unlink(cleanupPath).catch(() => undefined);
      }
      if (!isFileSystemError(error, "EEXIST")) throw error;

      let ownerPid: number | undefined;
      try {
        const raw = (await readFile(cleanupPath, "utf8")).trim();
        const parsed = Number(raw);
        if (Number.isInteger(parsed) && parsed > 0) ownerPid = parsed;
      } catch (readError) {
        if (isFileSystemError(readError, "ENOENT")) continue;
      }

      if (ownerPid !== undefined && !isProcessAlive(ownerPid)) {
        await unlink(cleanupPath).catch((unlinkError) => {
          if (!isFileSystemError(unlinkError, "ENOENT")) throw unlinkError;
        });
        continue;
      }

      throw new IntegrationLockError(
        ownerPid,
        "A Scribe stale-lock recovery is already in progress. If no Scribe process is running and this persists, remove .scribe-integrate.lock.cleanup manually and retry."
      );
    }
  }

  try {
    const current = await readLockRecord(lockPath);
    if (current.record === undefined || current.malformed) return;
    if (current.record.token !== stale.token) return;
    if (isProcessAlive(current.record.pid)) throw new IntegrationLockError(current.record.pid);

    await unlink(lockPath).catch((error) => {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    });
    await syncDirectory(root);
  } finally {
    await cleanupHandle.close().catch(() => undefined);
    await unlink(cleanupPath).catch(() => undefined);
  }
}

async function readLockRecord(lockPath: string): Promise<LockReadResult> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockRecord>;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.startedAt !== "number" ||
      !Number.isFinite(parsed.startedAt) ||
      typeof parsed.token !== "string" ||
      parsed.token.length === 0
    ) {
      return { malformed: true };
    }
    return {
      malformed: false,
      record: { pid: parsed.pid, startedAt: parsed.startedAt, token: parsed.token }
    };
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return { malformed: false };
    return { malformed: true };
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

async function writeDurableExclusiveFile(path: string, content: Buffer): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(dirname(path));
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
}

async function resolveSafeProjectPath(root: string, input: string): Promise<string> {
  const normalized = normalizeRelativeProjectPath(input);
  const canonicalRoot = await realpath(root);
  const lexical = resolve(canonicalRoot, normalized);
  assertContained(canonicalRoot, lexical, input);

  const existingAncestor = await nearestExistingAncestor(dirname(lexical));
  const canonicalAncestor = await realpath(existingAncestor);
  assertContained(canonicalRoot, canonicalAncestor, input);

  try {
    const info = await lstat(lexical);
    if (info.isSymbolicLink()) throw new Error(`Refusing symbolic-link transaction target ${input}.`);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }

  return lexical;
}

async function nearestExistingAncestor(start: string): Promise<string> {
  let current = start;
  for (;;) {
    try {
      await access(current, constants.F_OK);
      return current;
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function normalizeRelativeProjectPath(input: string): string {
  if (input.length === 0 || input.includes("\0")) throw new Error("Transaction paths must be non-empty filesystem paths.");
  if (isAbsolute(input)) throw new Error(`Transaction paths must be project-relative: ${input}`);
  const normalized = input.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..")) throw new Error(`Transaction path escapes the project root: ${input}`);
  const result = parts.filter((part) => part !== "" && part !== ".").join("/");
  if (result.length === 0) throw new Error(`Transaction path must identify a file inside the project root: ${input}`);
  return result;
}

function assertContained(root: string, target: string, input: string): void {
  const value = relative(root, target);
  if (value === "") return;
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error(`Transaction path escapes the project root: ${input}`);
  }
}

async function readRegularFile(path: string, displayPath: string): Promise<Buffer> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`Refusing symbolic-link transaction target ${displayPath}.`);
  if (!info.isFile()) throw new Error(`Transaction target ${displayPath} is not a regular file.`);
  return readFile(path);
}

function sameExpectedState(left: ExpectedFileState, right: ExpectedFileState): boolean {
  if (left.kind === "missing" || right.kind === "missing") return left.kind === right.kind;
  return left.hash === right.hash;
}

function toBuffer(content: string | Buffer): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
}

function hashBytes(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Best effort only: directory fsync is not portable across every filesystem.
    // The file itself is fsynced before rename/link, which is the portable floor.
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
