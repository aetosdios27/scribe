import { link, mkdir, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { compileScribeMdx } from "@scribe-sdk/mdx";

import {
  ContentPathUsageError,
  chooseContentDirectory,
  displayWorkspacePath
} from "./content-paths.js";
import {
  readMediumArchive,
  type MediumArchive,
  type MediumArchivePost
} from "./medium-archive.js";
import {
  downloadMediumAssets,
  type MediumAssetPlan,
  type MediumAssetResult
} from "./medium-assets.js";
import {
  convertMediumPost,
  type ConvertedMediumPost,
  type ImportWarning
} from "./medium-convert.js";

export type MediumImportOptions = {
  readonly into?: string;
  readonly includeDrafts?: boolean;
  readonly includeResponses?: boolean;
  readonly downloadAssets?: boolean;
};

export type MediumImportArticle = ConvertedMediumPost & {
  readonly source: MediumArchivePost;
  readonly targetPath: string;
};

export type MediumImportPlan = {
  readonly root: string;
  readonly archivePath: string;
  readonly contentDirectory: string;
  readonly articles: readonly MediumImportArticle[];
  readonly availableDrafts: number;
  readonly skippedDrafts: number;
  readonly availableResponseCandidates: number;
  readonly skippedResponseCandidates: number;
  readonly downloadAssets: boolean;
};

export type MediumImportDependencies = {
  readonly readArchive?: typeof readMediumArchive;
  readonly convertPost?: typeof convertMediumPost;
  readonly compile?: (source: { readonly path: string; readonly value: string }) => Promise<unknown>;
  readonly downloadAssets?: (
    plan: MediumAssetPlan
  ) => Promise<MediumAssetResult>;
  readonly writeArticle?: (path: string, source: string) => Promise<void>;
};


class MediumImportError extends Error {}

export async function planMediumImport(
  rootInput: string,
  archiveInput: string,
  options: MediumImportOptions = {},
  dependencies: MediumImportDependencies = {}
): Promise<MediumImportPlan> {
  const root = resolve(rootInput);
  const archivePath = resolveArchivePath(root, archiveInput);
  const archive = await (dependencies.readArchive ?? readMediumArchive)(archivePath);
  return createMediumImportPlan(root, archivePath, archive, options, dependencies);
}

export interface MediumImportApplyResult {
  readonly articles: number;
  readonly createdFiles: readonly string[];
  readonly warnings: readonly ImportWarning[];
}

export async function applyMediumImportPlan(
  plan: MediumImportPlan,
  dependencies: Pick<
    MediumImportDependencies,
    "downloadAssets" | "writeArticle"
  > = {}
): Promise<MediumImportApplyResult> {
  const createdFiles: string[] = [];
  const createdDirectories = new Set<string>();
  const warnings: ImportWarning[] = plan.articles.flatMap((article) => article.warnings);
  try {
    for (const article of plan.articles) {
      let markdown = article.markdown;
      if (plan.downloadAssets && article.assets.length > 0) {
        const assetResult = await trackCreatedDirectories(
          plan.root,
          join(plan.root, "public", "scribe-imports", article.slug),
          createdDirectories,
          () => (dependencies.downloadAssets ?? downloadMediumAssets)({
            root: plan.root,
            slug: article.slug,
            markdown,
            assets: article.assets
          })
        );
        markdown = assetResult.markdown;
        createdFiles.push(...assetResult.createdFiles);
        warnings.push(...assetResult.warnings);
      }
      await trackCreatedDirectories(
        plan.root,
        dirname(article.targetPath),
        createdDirectories,
        () => (dependencies.writeArticle ?? writeArticleExclusively)(
          article.targetPath,
          markdown
        )
      );
      createdFiles.push(article.targetPath);
    }
  } catch (error) {
    await rollbackCreatedFiles(plan.root, createdFiles, createdDirectories);
    throw new MediumImportError(
      `Medium import failed and newly created files were rolled back: ${errorMessage(error)}`
    );
  }
  return { articles: plan.articles.length, createdFiles, warnings };
}


async function createMediumImportPlan(
  root: string,
  archivePath: string,
  archive: MediumArchive,
  options: MediumImportOptions,
  dependencies: MediumImportDependencies
): Promise<MediumImportPlan> {
  const contentDirectory = await chooseContentDirectory(root, options.into, "--into");
  const availableDrafts = archive.posts.filter((post) => post.status === "draft").length;
  const selected = archive.posts.filter((post) => post.status === "published" || options.includeDrafts === true);
  if (selected.length === 0) {
    throw new MediumImportError(
      availableDrafts > 0
        ? "the export contains only unpublished drafts; pass --include-drafts to import them."
        : "the export does not contain any Medium stories."
    );
  }

  const articles: MediumImportArticle[] = [];
  const slugs = new Set<string>();
  let availableResponseCandidates = 0;
  for (const source of selected) {
    const converted = await (dependencies.convertPost ?? convertMediumPost)(source);
    if (converted.kind === "response-candidate") {
      availableResponseCandidates += 1;
      if (options.includeResponses !== true) continue;
    }
    if (slugs.has(converted.slug)) {
      throw new MediumImportError(`multiple Medium stories resolve to the duplicate slug "${converted.slug}".`);
    }
    slugs.add(converted.slug);
    const targetPath = join(contentDirectory, `${converted.slug}.mdx`);
    if (await pathExists(targetPath)) {
      throw new MediumImportError(`${displayWorkspacePath(root, targetPath)} already exists; Scribe will not overwrite it.`);
    }
    await (dependencies.compile ?? compileMediumArticle)({
      path: targetPath,
      value: converted.markdown
    });
    articles.push({ ...converted, source, targetPath });
  }

  return {
    root,
    archivePath,
    contentDirectory,
    articles,
    availableDrafts,
    skippedDrafts: options.includeDrafts === true ? 0 : availableDrafts,
    availableResponseCandidates,
    skippedResponseCandidates: options.includeResponses === true ? 0 : availableResponseCandidates,
    downloadAssets: options.downloadAssets !== false
  };
}

function resolveArchivePath(root: string, archiveInput: string): string {
  if (archiveInput.length === 0) throw new ContentPathUsageError("Expected a Medium export ZIP.");
  return isAbsolute(archiveInput) ? resolve(archiveInput) : resolve(root, archiveInput);
}


async function compileMediumArticle(source: { readonly path: string; readonly value: string }): Promise<void> {
  await compileScribeMdx(source);
}

async function writeArticleExclusively(path: string, source: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${randomUUID()}.scribe-import.tmp`);
  await writeFile(temporary, source, { encoding: "utf8", flag: "wx", mode: 0o644 });
  try {
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function rollbackCreatedFiles(
  root: string,
  createdFiles: readonly string[],
  createdDirectories: ReadonlySet<string>
): Promise<void> {
  for (const path of [...createdFiles].reverse()) {
    if (!isWithinRoot(root, path)) continue;
    await unlink(path).catch(() => undefined);
  }
  for (const directory of [...createdDirectories].sort((left, right) => right.length - left.length)) {
    await rmdir(directory).catch(() => undefined);
  }
}

async function trackCreatedDirectories<T>(
  root: string,
  target: string,
  createdDirectories: Set<string>,
  operation: () => Promise<T>
): Promise<T> {
  const candidates: string[] = [];
  let directory = resolve(target);
  if (!isWithinRoot(root, directory)) throw new Error("Import target escaped the project root.");
  while (directory !== root) {
    if (!(await pathExists(directory))) candidates.push(directory);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  try {
    return await operation();
  } finally {
    for (const candidate of candidates) {
      if (await pathExists(candidate)) createdDirectories.add(candidate);
    }
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (
    path !== ".."
    && !path.startsWith(`..${sep}`)
    && !isAbsolute(path)
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() || info.isDirectory();
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw error;
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
