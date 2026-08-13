import { open, mkdir, lstat, rm, type FileHandle } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

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
import { promptConfirm, promptText, renderPanel, renderReceipt } from "./terminal-ui.js";
import {
  renderLogo,
  renderLogoFallback,
  supportsTrueColorFor
} from "./logo.js";

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
  readonly version?: string;
  readonly isTTY?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly columns?: number;
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

  const injectedPrompt = dependencies.prompt;
  const injectedConfirm = dependencies.confirm;
  const terminalInteractive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const outputIsTTY = dependencies.isTTY ?? process.stdout.isTTY === true;
  const columns = dependencies.columns ?? process.stdout.columns ?? 80;
  if (outputIsTTY) {
    stdout(renderStudioInitHeader(
      dependencies.version ?? "0.1.0-beta",
      columns >= 48 && supportsTrueColorFor({
        isTTY: outputIsTTY,
        env: dependencies.env ?? process.env
      })
    ));
  }

  try {
    const inputRoot = dependencies.cwd ?? process.cwd();
    const root = await findSupportedProjectRoot(inputRoot) ?? resolve(inputRoot);
    const contentDirectory = parsed.path === undefined
      ? await chooseContentDirectory(root, parsed.contentDirectory, "--content-dir")
      : undefined;
    const title = parsed.title ?? await askTitle(injectedPrompt, terminalInteractive);
    if (title === null) {
      stdout(renderReceipt("cancelled", "No article was created."));
      return 0;
    }

    const derivedSlug = deriveArticleSlug(title);
    const slug = parsed.slug ?? await askEditable(
      injectedPrompt,
      terminalInteractive,
      parsed.yes,
      "Slug",
      derivedSlug,
      validateArticleSlug
    );
    if (slug === null) {
      stdout(renderReceipt("cancelled", "No article was created."));
      return 0;
    }

    const defaultPath = contentDirectory === undefined
      ? ""
      : displayWorkspacePath(root, resolve(contentDirectory, `${slug}.mdx`));
    const selectedPath = parsed.path ?? await askEditable(
      injectedPrompt,
      terminalInteractive,
      parsed.yes,
      "Article path",
      defaultPath,
      (value) => {
        try {
          const targetPath = resolveInsideWorkspace(root, value, "Article path");
          return articleExtensions[extname(targetPath).toLowerCase()] === true
            ? undefined
            : "Article path must end in .md or .mdx.";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }
    );
    if (selectedPath === null) {
      stdout(renderReceipt("cancelled", "No article was created."));
      return 0;
    }

    const plan = await planStudioArticle(root, {
      title,
      slug,
      path: selectedPath,
      ...(parsed.contentDirectory === undefined ? {} : { contentDirectory: parsed.contentDirectory })
    });
    const shownPath = displayWorkspacePath(plan.root, plan.targetPath);
    stdout(renderPanel({
      title: "Scribe Studio · New article",
      description: "Review the source file before creation.",
      rows: [
        { label: "Content", value: displayWorkspacePath(plan.root, plan.contentDirectory) },
        { label: "Title", value: plan.title },
        { label: "Slug", value: plan.slug },
        { label: "Path", value: shownPath }
      ],
      footer: "Scribe will create one minimal MDX file and open Studio."
    }));

    const confirmed = parsed.yes
      ? true
      : injectedConfirm === undefined
        ? await promptConfirm("Create and open this article?")
        : await injectedConfirm("Create this article?");
    if (confirmed === null) {
      stderr("The terminal is non-interactive. Re-run with --title and --yes after reviewing the target path.\n");
      return 2;
    }
    if (!confirmed) {
      stdout(renderReceipt("cancelled", "No article was created."));
      return 0;
    }

    await createStudioArticle(plan);
    stdout(renderReceipt("success", "Article created", [
      shownPath,
      "Opening Scribe Studio…"
    ]));
    const launchStudio = dependencies.launchStudio ?? runStudio;
    return launchStudio([...parsed.studioArgs, "--", shownPath], {
      cwd: plan.root,
      stdout,
      stderr
    });
  } catch (error) {
    stderr(renderReceipt(
      "error",
      error instanceof Error ? error.message : String(error)
    ));
    return error instanceof ContentPathUsageError ? 2 : 1;
  }
}
export function renderStudioInitHeader(version: string, trueColor: boolean): string {
  if (!trueColor) {
    return `${renderLogoFallback()}  S C R I B E\n     Publishing SDK · ${version}\n`;
  }
  const mark = renderLogo().split("\n");
  const heading = ["", "S C R I B E", `Publishing SDK · ${version}`, ""];
  return `${mark.map((line, index) => `${line}  ${heading[index] ?? ""}`).join("\n")}\n`;
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

async function askTitle(
  prompt: ((question: string) => Promise<string | null>) | undefined,
  terminalInteractive: boolean
): Promise<string | null> {
  if (prompt !== undefined) return askRequired(prompt, "Article title: ");
  if (!terminalInteractive) {
    throw new ContentPathUsageError("Article title is required in a non-interactive terminal. Pass --title.");
  }
  const value = await promptText({
    message: "Article title",
    placeholder: "The Smallest Honest Redis Clone",
    validate: (candidate) => {
      const normalized = candidate.trim();
      return normalized === "" || /[\r\n]/u.test(normalized)
        ? "Enter one non-empty line."
        : undefined;
    }
  });
  return value === null ? null : value.trim();
}

async function askEditable(
  prompt: ((question: string) => Promise<string | null>) | undefined,
  terminalInteractive: boolean,
  acceptDefault: boolean,
  label: string,
  fallback: string,
  validate: (value: string) => string | undefined
): Promise<string | null> {
  if (acceptDefault) return fallback;
  if (prompt !== undefined) return askDefault(prompt, `${label} [${fallback}]: `, fallback);
  if (!terminalInteractive) return fallback;
  const value = await promptText({
    message: label,
    initialValue: fallback,
    validate: (candidate) => validate(candidate.trim() === "" ? fallback : candidate.trim())
  });
  if (value === null) return null;
  return value.trim() === "" ? fallback : value.trim();
}

function validateArticleSlug(value: string): string | undefined {
  return /^[\p{Letter}\p{Number}]+(?:-[\p{Letter}\p{Number}]+)*$/u.test(value)
    ? undefined
    : "Use letters or numbers separated by single hyphens.";
}

async function askRequired(
  prompt: (question: string) => Promise<string | null>,
  question: string
): Promise<string | null> {
  const value = await prompt(question);
  return value === null ? null : value.trim();
}

async function askDefault(
  prompt: (question: string) => Promise<string | null>,
  question: string,
  fallback: string
): Promise<string | null> {
  const value = await prompt(question);
  if (value === null) return null;
  return value.trim() === "" ? fallback : value.trim();
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
