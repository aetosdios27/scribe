import { access, link, mkdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";

import type { ImportWarning, MediumAssetReference } from "./medium-convert.js";
import { assertNoSymbolicLinkComponents } from "./content-paths.js";

export type MediumAssetPlan = {
  root: string;
  slug: string;
  markdown: string;
  assets: readonly MediumAssetReference[];
  dryRun?: boolean;
  maximumAssetBytes?: number;
  requestTimeoutMilliseconds?: number;
};

export type MediumAssetResult = {
  markdown: string;
  createdFiles: string[];
  warnings: ImportWarning[];
};

export type MediumAssetDependencies = {
  fetch?: typeof globalThis.fetch;
};

const MIME_EXTENSIONS = new Map([
  ["image/avif", ".avif"],
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"]
]);
const DEFAULT_MAXIMUM_ASSET_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;
const MAXIMUM_REDIRECTS = 5;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`${name} must be a positive integer.`);
  return resolved;
}

function validateAssetUrl(url: URL): void {
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || !(hostname === "medium.com" || hostname.endsWith(".medium.com"))
  ) {
    throw new Error(`refused non-Medium HTTPS asset URL ${url.href}`);
  }
}

async function fetchAsset(
  initialUrl: URL,
  fetchImplementation: typeof globalThis.fetch,
  signal: AbortSignal
): Promise<Response> {
  let current = new URL(initialUrl);
  validateAssetUrl(current);
  for (let redirects = 0; redirects <= MAXIMUM_REDIRECTS; redirects += 1) {
    const response = await fetchImplementation(current, {
      headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/gif" },
      redirect: "manual",
      signal
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error(`redirect from ${current.href} did not include a location`);
    if (redirects === MAXIMUM_REDIRECTS) throw new Error(`asset exceeded ${MAXIMUM_REDIRECTS} redirects`);
    current = new URL(location, current);
    validateAssetUrl(current);
  }
  throw new Error(`asset exceeded ${MAXIMUM_REDIRECTS} redirects`);
}

async function boundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error(`asset contains more than ${maximumBytes} bytes`);
  }
  if (!response.body) throw new Error("asset response did not contain a body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error(`asset contains more than ${maximumBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function assetStem(url: URL): string {
  let filename: string;
  try {
    filename = decodeURIComponent(basename(url.pathname));
  } catch {
    filename = basename(url.pathname);
  }
  const stem = filename
    .slice(0, filename.length - extname(filename).length)
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 72)
    .replace(/-+$/u, "");
  return stem || "image";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeUniqueAsset(
  directory: string,
  stem: string,
  extension: string,
  bytes: Uint8Array
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${stem}-${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
  try {
    for (let index = 1; ; index += 1) {
      const suffix = index === 1 ? "" : `-${index}`;
      const candidate = join(directory, `${stem}${suffix}${extension}`);
      if (await exists(candidate)) continue;
      try {
        await link(temporary, candidate);
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function replaceReference(markdown: string, source: string, destination: string): string {
  return markdown.split(source).join(destination);
}

export async function downloadMediumAssets(
  plan: MediumAssetPlan,
  dependencies: MediumAssetDependencies = {}
): Promise<MediumAssetResult> {
  if (plan.dryRun) return { markdown: plan.markdown, createdFiles: [], warnings: [] };
  const maximumBytes = positiveInteger(
    plan.maximumAssetBytes,
    DEFAULT_MAXIMUM_ASSET_BYTES,
    "maximumAssetBytes"
  );
  const timeoutMilliseconds = positiveInteger(
    plan.requestTimeoutMilliseconds,
    DEFAULT_TIMEOUT_MILLISECONDS,
    "requestTimeoutMilliseconds"
  );
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const grouped = new Map<string, MediumAssetReference[]>();
  for (const reference of plan.assets) {
    const existing = grouped.get(reference.originalUrl.href);
    if (existing) existing.push(reference);
    else grouped.set(reference.originalUrl.href, [reference]);
  }

  let markdown = plan.markdown;
  const createdFiles: string[] = [];
  const warnings: ImportWarning[] = [];
  const directory = join(plan.root, "public", "scribe-imports", plan.slug);
  await assertNoSymbolicLinkComponents(plan.root, directory);
  for (const [source, references] of grouped) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
    try {
      const response = await fetchAsset(new URL(source), fetchImplementation, controller.signal);
      if (!response.ok) throw new Error(`asset request returned HTTP ${response.status}`);
      const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      const extension = mime === undefined ? undefined : MIME_EXTENSIONS.get(mime);
      if (!extension) throw new Error(`asset response used unsupported MIME type ${mime ?? "(missing)"}`);
      const bytes = await boundedBody(response, maximumBytes);
      const created = await writeUniqueAsset(directory, assetStem(new URL(source)), extension, bytes);
      createdFiles.push(created);
      const publicReference = `/scribe-imports/${plan.slug}/${basename(created)}`;
      for (const reference of references) {
        markdown = replaceReference(markdown, reference.articleReference, publicReference);
      }
    } catch (error) {
      const reason = controller.signal.aborted
        ? `asset request timed out after ${timeoutMilliseconds}ms`
        : error instanceof Error ? error.message : String(error);
      warnings.push({
        code: "medium-asset-download-failed",
        message: `Kept the remote image URL because ${reason}.`,
        source
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  return { markdown, createdFiles, warnings };
}
