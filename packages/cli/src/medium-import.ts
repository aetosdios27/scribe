import { link, mkdir, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { compileScribeMdx } from "@scribe-sdk/mdx";

import {
  ContentPathUsageError,
  chooseContentDirectory,
  displayWorkspacePath
} from "./content-paths.js";
import { importHelp } from "./command-help.js";
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
import { promptConfirm } from "./terminal-ui.js";

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
  readonly cwd?: string;
  readonly stdout?: (value: string) => void;
  readonly stderr?: (value: string) => void;
  readonly confirm?: (question: string, defaultValue: boolean) => Promise<boolean>;
  readonly readArchive?: typeof readMediumArchive;
  readonly convertPost?: typeof convertMediumPost;
  readonly compile?: (source: { readonly path: string; readonly value: string }) => Promise<unknown>;
  readonly downloadAssets?: (
    plan: MediumAssetPlan
  ) => Promise<MediumAssetResult>;
  readonly writeArticle?: (path: string, source: string) => Promise<void>;
};

type ParsedMediumImportArguments = {
  readonly archivePath: string;
  readonly dryRun: boolean;
  readonly help: boolean;
  readonly includeDrafts: boolean;
  readonly includeDraftsSpecified: boolean;
  readonly includeResponses: boolean;
  readonly includeResponsesSpecified: boolean;
  readonly downloadAssets: boolean;
  readonly downloadAssetsSpecified: boolean;
  readonly into?: string;
  readonly yes: boolean;
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

export async function runMediumImport(
  args: readonly string[],
  dependencies: MediumImportDependencies = {}
): Promise<number> {
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = dependencies.stderr ?? ((value: string) => process.stderr.write(value));
  const parsed = parseMediumImportArguments(args);
  if (typeof parsed === "string") {
    stderr(`${parsed}\n${importHelp}`);
    return 2;
  }
  if (parsed.help) {
    stdout(importHelp);
    return 0;
  }

  const root = resolve(dependencies.cwd ?? process.cwd());
  let archive: MediumArchive;
  let archivePath: string;
  try {
    archivePath = resolveArchivePath(root, parsed.archivePath);
    archive = await (dependencies.readArchive ?? readMediumArchive)(archivePath);
  } catch (error) {
    stderr(`Could not inspect the Medium export: ${errorMessage(error)}\n`);
    return error instanceof ContentPathUsageError ? 2 : 1;
  }

  const availableDrafts = archive.posts.filter((post) => post.status === "draft").length;
  let includeDrafts = parsed.includeDrafts;
  const confirm = dependencies.confirm ?? confirmInteractively;
  if (!parsed.dryRun && !parsed.yes) {
    if (!parsed.includeDraftsSpecified && availableDrafts > 0) {
      includeDrafts = await confirm(
        `Include ${availableDrafts} unpublished Medium draft${availableDrafts === 1 ? "" : "s"}?`,
        false
      );
    }
  }

  let plan: MediumImportPlan;
  try {
    plan = await createMediumImportPlan(root, archivePath, archive, {
      ...(parsed.into === undefined ? {} : { into: parsed.into }),
      includeDrafts,
      includeResponses: parsed.includeResponses,
      downloadAssets: parsed.downloadAssets
    }, dependencies);
  } catch (error) {
    stderr(`Could not prepare the Medium import: ${errorMessage(error)}\n`);
    return error instanceof ContentPathUsageError ? 2 : 1;
  }

  if (
    !parsed.dryRun
    && !parsed.yes
    && !parsed.includeResponsesSpecified
    && plan.availableResponseCandidates > 0
  ) {
    const includeResponses = await confirm(
      `Medium does not label responses in its export. Include ${plan.availableResponseCandidates} response-shaped ${plan.availableResponseCandidates === 1 ? "entry" : "entries"}?`,
      false
    );
    if (includeResponses) {
      try {
        plan = await createMediumImportPlan(root, archivePath, archive, {
          ...(parsed.into === undefined ? {} : { into: parsed.into }),
          includeDrafts,
          includeResponses: true,
          downloadAssets: parsed.downloadAssets
        }, dependencies);
      } catch (error) {
        stderr(`Could not prepare the Medium import: ${errorMessage(error)}\n`);
        return error instanceof ContentPathUsageError ? 2 : 1;
      }
    }
  }

  if (
    !parsed.dryRun
    && !parsed.yes
    && !parsed.downloadAssetsSpecified
    && plan.articles.some((article) => article.assets.length > 0)
  ) {
    plan = {
      ...plan,
      downloadAssets: await confirm("Download referenced Medium images locally?", true)
    };
  }

  stdout(formatMediumImportPlan(plan, parsed.dryRun));
  if (parsed.dryRun) return 0;
  if (!parsed.yes) {
    const confirmed = await confirm(
      `Import ${plan.articles.length} Medium ${plan.articles.length === 1 ? "story" : "stories"}?`,
      false
    );
    if (!confirmed) {
      stdout("No files were changed.\n");
      return 0;
    }
  }

  const createdFiles: string[] = [];
  const createdDirectories = new Set<string>();
  const warnings: ImportWarning[] = plan.articles.flatMap((article) => article.warnings);
  try {
    for (const article of plan.articles) {
      let markdown = article.markdown;
      if (plan.downloadAssets && article.assets.length > 0) {
        const assetResult = await trackCreatedDirectories(
          root,
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
        root,
        dirname(article.targetPath),
        createdDirectories,
        () => (dependencies.writeArticle ?? writeArticleExclusively)(article.targetPath, markdown)
      );
      createdFiles.push(article.targetPath);
    }
  } catch (error) {
    await rollbackCreatedFiles(root, createdFiles, createdDirectories);
    stderr(`Medium import failed and newly created files were rolled back: ${errorMessage(error)}\n`);
    return 1;
  }

  stdout(formatMediumImportResult(plan, warnings));
  return 0;
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

function parseMediumImportArguments(args: readonly string[]): ParsedMediumImportArguments | string {
  let archivePath: string | undefined;
  let dryRun = false;
  let help = false;
  let includeDrafts = false;
  let includeDraftsSpecified = false;
  let includeResponses = false;
  let includeResponsesSpecified = false;
  let downloadAssets = true;
  let downloadAssetsSpecified = false;
  let into: string | undefined;
  let yes = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--into") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) return "--into requires a repository-relative directory.";
      into = value;
      index += 1;
    } else if (argument?.startsWith("--into=")) {
      into = argument.slice("--into=".length);
      if (into.length === 0) return "--into requires a repository-relative directory.";
    } else if (argument === "--include-drafts") {
      includeDrafts = true;
      includeDraftsSpecified = true;
    } else if (argument === "--include-responses") {
      includeResponses = true;
      includeResponsesSpecified = true;
    } else if (argument === "--no-download-assets") {
      downloadAssets = false;
      downloadAssetsSpecified = true;
    } else if (argument === "--dry-run") dryRun = true;
    else if (argument === "--yes") yes = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument?.startsWith("-")) return `Unknown import option "${argument}".`;
    else if (archivePath === undefined) archivePath = argument;
    else return "Expected exactly one Medium export ZIP.";
  }

  if (help) {
    return {
      archivePath: archivePath ?? "",
      dryRun,
      help,
      includeDrafts,
      includeDraftsSpecified,
      includeResponses,
      includeResponsesSpecified,
      downloadAssets,
      downloadAssetsSpecified,
      ...(into === undefined ? {} : { into }),
      yes
    };
  }
  if (archivePath === undefined) return "Expected exactly one Medium export ZIP.";
  return {
    archivePath,
    dryRun,
    help,
    includeDrafts,
    includeDraftsSpecified,
    includeResponses,
    includeResponsesSpecified,
    downloadAssets,
    downloadAssetsSpecified,
    ...(into === undefined ? {} : { into }),
    yes
  };
}

function formatMediumImportPlan(plan: MediumImportPlan, dryRun: boolean): string {
  return [
    `Scribe import — ${dryRun ? "dry run" : "Medium export"}`,
    dryRun ? "No network requests or file changes will be made." : "Review the import before confirming.",
    "",
    `Archive  ${displayWorkspacePath(plan.root, plan.archivePath)}`,
    `Into     ${displayWorkspacePath(plan.root, plan.contentDirectory)}`,
    `Stories  ${plan.articles.length}`,
    `Drafts   ${plan.availableDrafts === 0
      ? "none in export"
      : plan.skippedDrafts === 0
        ? `${plan.availableDrafts} included`
        : `${plan.skippedDrafts} skipped`}`,
    `Responses ${plan.availableResponseCandidates === 0
      ? "none detected"
      : plan.skippedResponseCandidates === 0
        ? `${plan.availableResponseCandidates} included by request`
        : `${plan.skippedResponseCandidates} response-shaped ${plan.skippedResponseCandidates === 1 ? "entry" : "entries"} skipped`}`,
    `Images   ${plan.downloadAssets ? "download to public/scribe-imports" : "keep remote URLs"}`,
    "",
    "Files",
    ...plan.articles.map((article) => `  ${displayWorkspacePath(plan.root, article.targetPath)}`),
    ""
  ].join("\n");
}

function formatMediumImportResult(plan: MediumImportPlan, warnings: readonly ImportWarning[]): string {
  return [
    `Imported  ${plan.articles.length} Medium ${plan.articles.length === 1 ? "story" : "stories"}`,
    `  ${displayWorkspacePath(plan.root, plan.contentDirectory)}`,
    ...(warnings.length === 0 ? [] : ["", `Warnings  ${warnings.length}`, ...warnings.map((warning) => `  ${warning.message}`)]),
    "",
    "Next",
    `  scribe studio ${displayWorkspacePath(plan.root, plan.articles[0]?.targetPath ?? plan.contentDirectory)}`,
    ""
  ].join("\n");
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

async function confirmInteractively(question: string, defaultValue: boolean): Promise<boolean> {
  return await promptConfirm(question, defaultValue) ?? false;
}
