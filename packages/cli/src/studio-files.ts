import { createHash, randomBytes } from "node:crypto";
import { open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { syncDirectory } from "./studio-fs.js";

export interface StudioFileSnapshot {
  readonly requestedPath: string;
  readonly resolvedPath: string;
  readonly source: string;
  readonly version: string;
  readonly lineEnding: "\n" | "\r\n";
  readonly bom: boolean;
  readonly mode: number;
  readonly device: number;
  readonly inode: number;
}

export interface DurableStudioWrite {
  readonly requestedPath: string;
  readonly resolvedPath: string;
  readonly expectedVersion: string;
  readonly expectedDevice: number;
  readonly expectedInode: number;
  readonly source: string;
  readonly lineEnding: "\n" | "\r\n";
  readonly bom: boolean;
  readonly mode: number;
  readonly beforeCommit?: () => Promise<void>;
}

export class StudioFileConflictError extends Error {
  constructor(message = "The source changed outside Studio before the save could commit.") {
    super(message);
    this.name = "StudioFileConflictError";
  }
}

export async function readStudioFile(requestedPath: string): Promise<StudioFileSnapshot> {
  const resolvedPath = await realpath(requestedPath);
  const info = await stat(resolvedPath);
  if (!info.isFile()) throw new Error(`Studio source is not a regular file: ${requestedPath}`);
  const bytes = await readFile(resolvedPath);
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const content = bom ? bytes.subarray(3) : bytes;
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(`Studio could not decode ${requestedPath} as UTF-8.`);
  }
  return {
    requestedPath,
    resolvedPath,
    source,
    version: fingerprintBytes(bytes),
    lineEnding: detectLineEnding(source),
    bom,
    mode: info.mode,
    device: info.dev,
    inode: info.ino
  };
}

export async function durableWriteStudioFile(options: DurableStudioWrite): Promise<StudioFileSnapshot> {
  const currentResolved = await realpath(options.requestedPath);
  if (currentResolved !== options.resolvedPath) {
    throw new StudioFileConflictError("The source symlink or file target changed outside Studio.");
  }

  const bytes = encodeStudioSource(options.source, options.lineEnding, options.bom);
  const temporaryPath = `${options.resolvedPath}.scribe-${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
  let temporaryExists = false;
  try {
    const temporary = await open(temporaryPath, "wx", options.mode & 0o7777);
    temporaryExists = true;
    try {
      await temporary.chmod(options.mode & 0o7777);
      await temporary.writeFile(bytes);
      await temporary.sync();
    } finally {
      await temporary.close();
    }

    if (options.beforeCommit !== undefined) await options.beforeCommit();

    const [currentBytes, currentInfo, resolvedAgain] = await Promise.all([
      readFile(options.resolvedPath),
      stat(options.resolvedPath),
      realpath(options.requestedPath)
    ]);
    if (
      resolvedAgain !== options.resolvedPath
      || fingerprintBytes(currentBytes) !== options.expectedVersion
      || currentInfo.dev !== options.expectedDevice
      || currentInfo.ino !== options.expectedInode
    ) {
      throw new StudioFileConflictError();
    }

    await rename(temporaryPath, options.resolvedPath);
    temporaryExists = false;
    await syncDirectory(dirname(options.resolvedPath));

    const committed = await readFile(options.resolvedPath);
    if (!committed.equals(bytes)) {
      throw new Error("Studio could not verify the bytes written to the source file.");
    }
    return readStudioFile(options.requestedPath);
  } finally {
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
  }
}

export function encodeStudioSource(source: string, lineEnding: "\n" | "\r\n", bom: boolean): Buffer {
  const normalized = source.replace(/\r\n?|\n/gu, "\n").replaceAll("\n", lineEnding);
  return Buffer.from(`${bom ? "\uFEFF" : ""}${normalized}`, "utf8");
}

function detectLineEnding(source: string): "\n" | "\r\n" {
  const crlf = source.match(/\r\n/gu)?.length ?? 0;
  const lf = source.match(/(?<!\r)\n/gu)?.length ?? 0;
  const bareCr = source.match(/\r(?!\n)/gu)?.length ?? 0;
  if (bareCr > 0) {
    throw new Error("Studio does not edit files with bare carriage returns or mixed line endings. Normalize the file first to avoid silent rewriting.");
  }
  if (crlf > 0 && lf > 0) {
    throw new Error("Studio does not edit files with mixed LF and CRLF line endings. Normalize the file first to avoid silent rewriting.");
  }
  return crlf > 0 ? "\r\n" : "\n";
}

function fingerprintBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
