import { open, mkdir, lstat, rm, type FileHandle } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

import {
  ContentPathUsageError,
  assertNoSymbolicLinkComponents,
  chooseContentDirectory,
  displayWorkspacePath,
  resolveInsideWorkspace
} from "./content-paths.js";

export interface StudioInitOptions {
  readonly title: string;
  readonly slug?: string;
  readonly contentDirectory?: string;
  readonly path?: string;
}

export interface StudioArticlePlan {
  readonly root: string;
  readonly title: string;
  readonly slug: string;
  readonly contentDirectory: string;
  readonly targetPath: string;
  readonly source: string;
}

const articleExtensions: Record<string, true> = {
  ".md": true,
  ".mdx": true
};

export function deriveArticleSlug(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
}

export async function planStudioArticle(
  rootInput: string,
  options: StudioInitOptions
): Promise<StudioArticlePlan> {
  const root = resolve(rootInput);
  const title = options.title.trim();
  if (title === "" || /[\r\n]/u.test(title)) {
    throw new ContentPathUsageError("Article title must be one non-empty line.");
  }

  const slug = (options.slug ?? deriveArticleSlug(title)).trim();
  if (!/^[\p{Letter}\p{Number}]+(?:-[\p{Letter}\p{Number}]+)*$/u.test(slug)) {
    throw new ContentPathUsageError("Article slug must contain letters or numbers separated by single hyphens.");
  }

  let contentDirectory: string;
  let targetPath: string;
  if (options.path === undefined) {
    contentDirectory = await chooseContentDirectory(root, options.contentDirectory, "--content-dir");
    targetPath = resolve(contentDirectory, `${slug}.mdx`);
  } else {
    targetPath = resolveInsideWorkspace(root, options.path, "Article path");
    contentDirectory = dirname(targetPath);
  }
  if (articleExtensions[extname(targetPath).toLowerCase()] !== true) {
    throw new ContentPathUsageError("Article path must end in .md or .mdx.");
  }
  await assertNoSymbolicLinkComponents(root, targetPath);
  await assertTargetMissing(root, targetPath);

  return {
    root,
    title,
    slug,
    contentDirectory,
    targetPath,
    source: `---\ntitle: ${JSON.stringify(title)}\n---\n`
  };
}

export async function createStudioArticle(plan: StudioArticlePlan): Promise<void> {
  await mkdir(dirname(plan.targetPath), { recursive: true });
  let handle: FileHandle | undefined;
  try {
    handle = await open(plan.targetPath, "wx", 0o644);
    await handle.writeFile(plan.source, "utf8");
    await handle.sync();
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
      handle = undefined;
      await rm(plan.targetPath, { force: true }).catch(() => undefined);
    }
    if (error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(`${displayWorkspacePath(plan.root, plan.targetPath)} already exists. Scribe will not overwrite it.`);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}


async function assertTargetMissing(root: string, path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${displayWorkspacePath(root, path)} already exists. Scribe will not overwrite it.`);
}
