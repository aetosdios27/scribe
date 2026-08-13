import { open, mkdir, lstat, rm, type FileHandle } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { suggestClosest } from "./cli-output.js";
import { studioInitHelp } from "./command-help.js";
import {
  ContentPathUsageError,
  assertNoSymbolicLinkComponents,
  chooseContentDirectory,
  displayWorkspacePath,
  resolveInsideWorkspace
} from "./content-paths.js";
import { findSupportedProjectRoot } from "./launcher.js";
import { runStudio } from "./studio.js";

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

export interface StudioInitDependencies {
  readonly cwd?: string;
  readonly stdout?: (value: string) => void;
  readonly stderr?: (value: string) => void;
  readonly prompt?: (question: string) => Promise<string | null>;
  readonly confirm?: (question: string) => Promise<boolean | null>;
  readonly launchStudio?: typeof runStudio;
}

interface ParsedStudioInitArguments {
  readonly contentDirectory?: string;
  readonly title?: string;
  readonly slug?: string;
  readonly path?: string;
  readonly yes: boolean;
  readonly help: boolean;
  readonly studioArgs: readonly string[];
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

  const contentDirectory = await chooseContentDirectory(root, options.contentDirectory, "--content-dir");
  const defaultPath = displayWorkspacePath(root, resolve(contentDirectory, `${slug}.mdx`));
  const targetPath = resolveInsideWorkspace(root, options.path ?? defaultPath, "Article path");
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
    if (handle !== undefined) await rm(plan.targetPath, { force: true }).catch(() => undefined);
    if (error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(`${displayWorkspacePath(plan.root, plan.targetPath)} already exists. Scribe will not overwrite it.`);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function runStudioInit(
  args: readonly string[],
  dependencies: StudioInitDependencies = {}
): Promise<number> {
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = dependencies.stderr ?? ((value: string) => process.stderr.write(value));
  const parsed = parseStudioInitArguments(args);
  if (typeof parsed === "string") {
    stderr(`${parsed}\n${studioInitHelp}`);
    return 2;
  }
  if (parsed.help) {
    stdout(studioInitHelp);
    return 0;
  }

  const session = dependencies.prompt === undefined && dependencies.confirm === undefined
    ? interactiveSession()
    : undefined;
  const prompt = dependencies.prompt ?? session?.prompt;
  const confirm = dependencies.confirm ?? session?.confirm;

  try {
    const inputRoot = dependencies.cwd ?? process.cwd();
    const root = await findSupportedProjectRoot(inputRoot) ?? resolve(inputRoot);
    const title = parsed.title ?? await askRequired(prompt, "Article title: ");
    if (title === null) {
      stdout("Cancelled. No article was created.\n");
      return 0;
    }
    const derivedSlug = parsed.slug ?? deriveArticleSlug(title);
    const slug = parsed.slug ?? await askDefault(prompt, `Slug [${derivedSlug}]: `, derivedSlug);
    if (slug === null) {
      stdout("Cancelled. No article was created.\n");
      return 0;
    }

    const contentDirectory = await chooseContentDirectory(
      root,
      parsed.contentDirectory,
      "--content-dir"
    );
    const defaultPath = displayWorkspacePath(
      root,
      resolve(contentDirectory, `${slug}.mdx`)
    );
    const selectedPath = parsed.path ?? await askDefault(prompt, `Article path [${defaultPath}]: `, defaultPath);
    if (selectedPath === null) {
      stdout("Cancelled. No article was created.\n");
      return 0;
    }

    const plan = await planStudioArticle(root, {
      title,
      slug,
      path: selectedPath,
      ...(parsed.contentDirectory === undefined ? {} : { contentDirectory: parsed.contentDirectory })
    });
    const shownPath = displayWorkspacePath(plan.root, plan.targetPath);
    stdout([
      "Scribe Studio — new article",
      "",
      `  Title  ${plan.title}`,
      `  Slug   ${plan.slug}`,
      `  Path   ${shownPath}`,
      ""
    ].join("\n"));

    const confirmed = parsed.yes ? true : confirm === undefined ? null : await confirm("Create this article?");
    if (confirmed === null) {
      stderr("The terminal is non-interactive. Re-run with --title and --yes after reviewing the target path.\n");
      return 2;
    }
    if (!confirmed) {
      stdout("Cancelled. No article was created.\n");
      return 0;
    }

    await createStudioArticle(plan);
    stdout(`Created  ${shownPath}\nOpening Scribe Studio…\n`);
    const launchStudio = dependencies.launchStudio ?? runStudio;
    return launchStudio([shownPath, ...parsed.studioArgs], {
      cwd: plan.root,
      stdout,
      stderr
    });
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof ContentPathUsageError ? 2 : 1;
  } finally {
    session?.close();
  }
}

function parseStudioInitArguments(args: readonly string[]): ParsedStudioInitArguments | string {
  let contentDirectory: string | undefined;
  let title: string | undefined;
  let slug: string | undefined;
  let path: string | undefined;
  let yes = false;
  let help = false;
  const studioArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--yes") yes = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (["--content-dir", "--title", "--slug", "--path"].includes(String(argument))) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) return `${String(argument)} requires a value.`;
      if (argument === "--content-dir") contentDirectory = value;
      else if (argument === "--title") title = value;
      else if (argument === "--slug") slug = value;
      else path = value;
      index += 1;
    } else if (["--mode", "--host-css", "--port"].includes(String(argument))) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) return `${String(argument)} requires a value.`;
      studioArgs.push(String(argument), value);
      index += 1;
    } else if (argument === "--no-open") studioArgs.push(argument);
    else {
      const value = String(argument);
      const suggestion = suggestClosest(value, ["--content-dir", "--title", "--slug", "--path", "--yes", "--mode", "--host-css", "--port", "--no-open", "--help"]);
      return `Unknown studio init option "${value}".${suggestion === undefined ? "" : ` Did you mean "${suggestion}"?`}`;
    }
  }

  return {
    ...(contentDirectory === undefined ? {} : { contentDirectory }),
    ...(title === undefined ? {} : { title }),
    ...(slug === undefined ? {} : { slug }),
    ...(path === undefined ? {} : { path }),
    yes,
    help,
    studioArgs
  };
}

function interactiveSession(): {
  readonly prompt: (question: string) => Promise<string | null>;
  readonly confirm: (question: string) => Promise<boolean | null>;
  readonly close: () => void;
} | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const interface_ = createInterface({ input: process.stdin, output: process.stdout });
  const question = async (value: string): Promise<string | null> => {
    try {
      return await interface_.question(value);
    } catch {
      return null;
    }
  };
  return {
    prompt: question,
    confirm: async (value) => {
      const answer = await question(`${value} [Y/n] `);
      return answer === null ? null : !/^(?:n|no)$/iu.test(answer.trim());
    },
    close: () => interface_.close()
  };
}

async function askRequired(
  prompt: ((question: string) => Promise<string | null>) | undefined,
  question: string
): Promise<string | null> {
  if (prompt === undefined) throw new ContentPathUsageError("Article title is required in a non-interactive terminal. Pass --title.");
  const value = await prompt(question);
  return value === null ? null : value.trim();
}

async function askDefault(
  prompt: ((question: string) => Promise<string | null>) | undefined,
  question: string,
  fallback: string
): Promise<string | null> {
  if (prompt === undefined) return fallback;
  const value = await prompt(question);
  if (value === null) return null;
  return value.trim() === "" ? fallback : value.trim();
}


async function assertTargetMissing(root: string, path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error(`${displayWorkspacePath(root, path)} already exists. Scribe will not overwrite it.`);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}
