import { readFile } from "node:fs/promises";

import { Unzip, UnzipInflate } from "fflate";

export type MediumArchiveLimits = {
  maximumArchiveBytes?: number;
  maximumEntries?: number;
  maximumEntryBytes?: number;
  maximumUncompressedBytes?: number;
};

export type MediumArchivePost = {
  entryPath: string;
  html: string;
  status: "published" | "draft";
};

export type MediumArchive = {
  posts: MediumArchivePost[];
};

type ZipEntry = {
  normalizedPath: string;
  originalSize: number;
  status?: MediumArchivePost["status"];
};

const DEFAULT_LIMITS = {
  maximumArchiveBytes: 256 * 1024 * 1024,
  maximumEntries: 10_000,
  maximumEntryBytes: 16 * 1024 * 1024,
  maximumUncompressedBytes: 256 * 1024 * 1024
} as const;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const UTF8_FLAG = 0x0800;
const ENCRYPTION_FLAGS = 0x0041;
const SUPPORTED_COMPRESSION_METHODS = new Set([0, 8]);

function archiveError(message: string): Error {
  return new Error(`Could not read Medium export: ${message}`);
}

function boundedLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw archiveError(`${label} must be a positive integer.`);
  return limit;
}

function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): number {
  const minimumOffset = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === bytes.byteLength) return offset;
  }
  throw archiveError("the selected file is not a valid ZIP archive.");
}

function decodeEntryName(bytes: Uint8Array, flags: number): string {
  if ((flags & UTF8_FLAG) === 0 && bytes.some((byte) => byte > 0x7f)) {
    throw archiveError("non-UTF-8 archive paths are not supported.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw archiveError("an archive entry has an invalid UTF-8 path.");
  }
}

function normalizeEntryPath(path: string): string {
  const slashPath = path.replaceAll("\\", "/").normalize("NFC");
  const segments = slashPath.split("/");
  if (
    slashPath.startsWith("/")
    || /^[A-Za-z]:\//u.test(slashPath)
    || segments.some((segment) => segment === ".." || segment === ".")
    || slashPath.includes("\0")
    || /[\u0001-\u001f\u007f]/u.test(slashPath)
  ) {
    throw archiveError(`unsafe archive path "${path}".`);
  }
  const normalized = segments.filter(Boolean).join("/");
  if (!normalized || normalized.length > 4096) throw archiveError(`unsafe archive path "${path}".`);
  return path.endsWith("/") ? `${normalized}/` : normalized;
}

function mediumStatus(path: string): MediumArchivePost["status"] | undefined {
  const segments = path.toLowerCase().split("/");
  const fileName = segments.at(-1);
  if (!fileName?.endsWith(".html")) return undefined;
  const directories = segments.slice(0, -1);
  if (directories.includes("drafts") || fileName.startsWith("draft_")) return "draft";
  if (directories.includes("posts")) return "published";
  return undefined;
}

function validateLocalHeader(
  bytes: Uint8Array,
  view: DataView,
  localOffset: number,
  expectedPath: string,
  expectedFlags: number,
  expectedCompression: number
): void {
  if (localOffset < 0 || localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER) {
    throw archiveError(`entry "${expectedPath}" has an invalid local header.`);
  }
  const flags = view.getUint16(localOffset + 6, true);
  const compression = view.getUint16(localOffset + 8, true);
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const nameStart = localOffset + 30;
  const nameEnd = nameStart + nameLength;
  if (nameEnd + extraLength > bytes.byteLength) throw archiveError(`entry "${expectedPath}" has a truncated local header.`);
  const localPath = normalizeEntryPath(decodeEntryName(bytes.subarray(nameStart, nameEnd), flags));
  if (localPath !== expectedPath || flags !== expectedFlags || compression !== expectedCompression) {
    throw archiveError(`entry "${expectedPath}" has mismatched ZIP metadata.`);
  }
}

function inspectCentralDirectory(bytes: Uint8Array, limits: Required<MediumArchiveLimits>): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(bytes, view);
  const disk = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const diskEntries = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
    throw archiveError("multi-disk ZIP archives are not supported.");
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw archiveError("ZIP64 archives are not supported.");
  }
  if (entryCount > limits.maximumEntries) {
    throw archiveError(`the archive contains more than ${limits.maximumEntries} entries.`);
  }
  if (centralOffset + centralSize > endOffset) throw archiveError("the ZIP central directory is invalid.");

  const entries: ZipEntry[] = [];
  const paths = new Set<string>();
  let totalUncompressedBytes = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset || view.getUint32(offset, true) !== CENTRAL_DIRECTORY_ENTRY) {
      throw archiveError("the ZIP central directory is invalid.");
    }
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const originalSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const startingDisk = view.getUint16(offset + 34, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > endOffset) throw archiveError("the ZIP central directory is truncated.");
    const originalPath = decodeEntryName(bytes.subarray(offset + 46, offset + 46 + nameLength), flags);
    const normalizedPath = normalizeEntryPath(originalPath);
    if (paths.has(normalizedPath)) throw archiveError(`duplicate archive path "${normalizedPath}".`);
    paths.add(normalizedPath);
    if ((flags & ENCRYPTION_FLAGS) !== 0) throw archiveError("encrypted ZIP entries are not supported.");
    if (!SUPPORTED_COMPRESSION_METHODS.has(compression)) {
      throw archiveError(`ZIP compression method ${compression} is not supported.`);
    }
    if (startingDisk !== 0 || originalSize === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw archiveError("ZIP64 and multi-disk entries are not supported.");
    }
    if (originalSize > limits.maximumEntryBytes) {
      throw archiveError(`entry "${normalizedPath}" is larger than ${limits.maximumEntryBytes} bytes.`);
    }
    totalUncompressedBytes += originalSize;
    if (totalUncompressedBytes > limits.maximumUncompressedBytes) {
      throw archiveError(`the archive expands to more than ${limits.maximumUncompressedBytes} uncompressed bytes.`);
    }
    validateLocalHeader(bytes, view, localOffset, normalizedPath, flags, compression);
    const status = mediumStatus(normalizedPath);
    entries.push({
      normalizedPath,
      originalSize,
      ...(status === undefined ? {} : { status })
    });
    offset = nextOffset;
  }
  if (offset !== centralOffset + centralSize) throw archiveError("the ZIP central-directory size is invalid.");
  return entries;
}

function concatenate(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function extractMediumEntries(
  bytes: Uint8Array,
  entries: readonly ZipEntry[],
  limits: Required<MediumArchiveLimits>
): Map<string, Uint8Array> {
  const wantedPaths = new Set(entries.filter((entry) => entry.status !== undefined).map((entry) => entry.normalizedPath));
  const extracted = new Map<string, Uint8Array>();
  let expandedBytes = 0;
  let failure: Error | undefined;
  const unzipper = new Unzip((file) => {
    if (failure) return;
    let normalizedPath: string;
    try {
      normalizedPath = normalizeEntryPath(file.name);
    } catch (error) {
      failure = error instanceof Error ? error : archiveError(String(error));
      return;
    }
    if (!wantedPaths.has(normalizedPath)) return;
    const chunks: Uint8Array[] = [];
    let entryBytes = 0;
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) {
        failure = archiveError(`entry "${normalizedPath}" could not be extracted: ${error.message}`);
        return;
      }
      entryBytes += chunk.byteLength;
      expandedBytes += chunk.byteLength;
      if (entryBytes > limits.maximumEntryBytes) {
        failure = archiveError(`entry "${normalizedPath}" expanded beyond ${limits.maximumEntryBytes} bytes.`);
        file.terminate();
        return;
      }
      if (expandedBytes > limits.maximumUncompressedBytes) {
        failure = archiveError(`the selected stories expand beyond ${limits.maximumUncompressedBytes} uncompressed bytes.`);
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) extracted.set(normalizedPath, concatenate(chunks, entryBytes));
    };
    file.start();
  });
  unzipper.register(UnzipInflate);

  try {
    const chunkSize = 16 * 1024;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      unzipper.push(bytes.subarray(offset, end), end === bytes.byteLength);
      if (failure) throw failure;
    }
  } catch (error) {
    if (failure) throw failure;
    throw archiveError(`the ZIP contents could not be extracted: ${error instanceof Error ? error.message : String(error)}`);
  }
  return extracted;
}

export async function readMediumArchive(
  path: string,
  requestedLimits: MediumArchiveLimits = {}
): Promise<MediumArchive> {
  const limits: Required<MediumArchiveLimits> = {
    maximumArchiveBytes: boundedLimit(requestedLimits.maximumArchiveBytes, DEFAULT_LIMITS.maximumArchiveBytes, "maximumArchiveBytes"),
    maximumEntries: boundedLimit(requestedLimits.maximumEntries, DEFAULT_LIMITS.maximumEntries, "maximumEntries"),
    maximumEntryBytes: boundedLimit(requestedLimits.maximumEntryBytes, DEFAULT_LIMITS.maximumEntryBytes, "maximumEntryBytes"),
    maximumUncompressedBytes: boundedLimit(
      requestedLimits.maximumUncompressedBytes,
      DEFAULT_LIMITS.maximumUncompressedBytes,
      "maximumUncompressedBytes"
    )
  };
  const file = await readFile(path);
  if (file.byteLength > limits.maximumArchiveBytes) {
    throw archiveError(`the archive is larger than ${limits.maximumArchiveBytes} bytes.`);
  }
  const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
  const entries = inspectCentralDirectory(bytes, limits);
  const extracted = extractMediumEntries(bytes, entries, limits);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const posts = entries
    .filter((entry): entry is ZipEntry & { status: MediumArchivePost["status"] } => entry.status !== undefined)
    .map((entry) => {
      const contents = extracted.get(entry.normalizedPath);
      if (!contents || contents.byteLength !== entry.originalSize) {
        throw archiveError(`entry "${entry.normalizedPath}" could not be extracted completely.`);
      }
      try {
        return {
          entryPath: entry.normalizedPath,
          html: decoder.decode(contents),
          status: entry.status
        };
      } catch {
        throw archiveError(`entry "${entry.normalizedPath}" is not valid UTF-8 HTML.`);
      }
    });
  return { posts };
}
