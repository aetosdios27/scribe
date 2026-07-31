import { mkdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { suggestClosest } from "./cli-output.js";
import { initHelp } from "./command-help.js";
import {
  ContentPathUsageError,
  chooseContentDirectory
} from "./content-paths.js";

export interface InitOptions {
  readonly contentDirectory?: string;
  readonly withAssets?: boolean;
}

export interface InitPlan {
  readonly root: string;
  readonly contentDirectory: string;
  readonly assetDirectory?: string;
  readonly directories: readonly string[];
  readonly existingDirectories: readonly string[];
}

export interface InitDependencies {
  readonly cwd?: string;
  readonly stdout?: (value: string) => void;
  readonly stderr?: (value: string) => void;
  readonly confirm?: (question: string) => Promise<boolean>;
}

export async function planInit(rootInput: string, options: InitOptions): Promise<InitPlan> {
  const root = resolve(rootInput);
  const contentDirectory = await chooseContentDirectory(root, options.contentDirectory, "--content-dir");
  const assetDirectory = options.withAssets ? resolve(root, "content/assets") : undefined;
  const candidates = [contentDirectory, assetDirectory].filter((path): path is string => path !== undefined);
  const existing = await existingAbsoluteDirectories(root, candidates);

  return {
    root,
    contentDirectory,
    ...(assetDirectory === undefined ? {} : { assetDirectory }),
    directories: candidates.filter((path) => !existing.includes(path)),
    existingDirectories: existing
  };
}

export async function runInit(args: readonly string[], dependencies: InitDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = dependencies.stderr ?? ((value: string) => process.stderr.write(value));
  const parsed = parseInitArguments(args);
  if (typeof parsed === "string") {
    stderr(`${parsed}\n${initHelp}`);
    return 2;
  }
  if (parsed.help) {
    stdout(initHelp);
    return 0;
  }

  let plan: InitPlan;
  try {
    plan = await planInit(dependencies.cwd ?? process.cwd(), {
      ...(parsed.contentDirectory === undefined ? {} : { contentDirectory: parsed.contentDirectory }),
      withAssets: parsed.withAssets
    });
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof ContentPathUsageError ? 2 : 1;
  }

  stdout(formatInitPlan(plan, parsed.dryRun));
  if (parsed.dryRun) return 0;

  const confirmed = parsed.yes || await (dependencies.confirm ?? confirmInteractively)("Create these Scribe content directories?");
  if (!confirmed) {
    stdout("No directories were created.\n");
    return 0;
  }

  try {
    for (const directory of plan.directories) await mkdir(directory, { recursive: true });
  } catch (error) {
    stderr(`Could not create the Scribe content launchpad: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  stdout([
    "Ready  Scribe content launchpad",
    `  Content  ${displayPath(plan.root, plan.contentDirectory)}`,
    `  Assets   ${plan.assetDirectory === undefined ? "not created" : displayPath(plan.root, plan.assetDirectory)}`,
    "",
    "No article, metadata, or framework files were generated.",
    "",
    "Next",
    "  Write an article in the content directory, then run:",
    `  scribe studio ${displayPath(plan.root, resolve(plan.contentDirectory, "your-article.mdx"))}`,
    "",
    "  To connect Scribe to the host website:",
    "  scribe integrate --dry-run",
    ""
  ].join("\n"));
  return 0;
}

interface ParsedInitArguments {
  readonly contentDirectory?: string;
  readonly dryRun: boolean;
  readonly help: boolean;
  readonly withAssets: boolean;
  readonly yes: boolean;
}

function parseInitArguments(args: readonly string[]): ParsedInitArguments | string {
  let contentDirectory: string | undefined;
  let dryRun = false;
  let help = false;
  let withAssets = false;
  let yes = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--content-dir") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) return "--content-dir requires a repository-relative path.";
      contentDirectory = value;
      index += 1;
    } else if (argument?.startsWith("--content-dir=")) {
      contentDirectory = argument.slice("--content-dir=".length);
      if (contentDirectory.length === 0) return "--content-dir requires a repository-relative path.";
    } else if (argument === "--with-assets") withAssets = true;
    else if (argument === "--dry-run") dryRun = true;
    else if (argument === "--yes") yes = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--mode" || argument?.startsWith("--mode=")) {
      const mode = argument === "--mode" ? args[index + 1] : argument.slice("--mode=".length);
      return `Style integration moved to \`scribe integrate\`. Run \`scribe integrate --mode ${mode ?? "<mode>"}\` instead.`;
    } else {
      const value = String(argument);
      const suggestion = suggestClosest(value, ["--content-dir", "--with-assets", "--dry-run", "--yes", "--help"]);
      return `Unknown init option "${value}".${suggestion === undefined ? "" : ` Did you mean "${suggestion}"?`}`;
    }
  }

  return {
    ...(contentDirectory === undefined ? {} : { contentDirectory }),
    dryRun,
    help,
    withAssets,
    yes
  };
}

function formatInitPlan(plan: InitPlan, dryRun: boolean): string {
  return [
    `Scribe init — ${dryRun ? "dry run" : "content launchpad"}`,
    dryRun ? "No directories will be changed." : "Review the content launchpad before confirming.",
    "",
    "Content",
    `  ${displayPath(plan.root, plan.contentDirectory)}${plan.existingDirectories.includes(plan.contentDirectory) ? " (existing)" : " (create)"}`,
    "",
    "Assets",
    plan.assetDirectory === undefined
      ? "  not requested"
      : `  ${displayPath(plan.root, plan.assetDirectory)}${plan.existingDirectories.includes(plan.assetDirectory) ? " (existing)" : " (create)"}`,
    "",
    "Generated content",
    "  none — No files will be generated.",
    "",
    "Next",
    dryRun
      ? "  Review this plan, then run `scribe init` with the same options."
      : "  Confirm to create only the directories listed above.",
    ""
  ].join("\n");
}

async function existingAbsoluteDirectories(root: string, candidates: readonly string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const path of candidates) {
    try {
      const info = await stat(path);
      if (!info.isDirectory()) throw new Error(`${displayPath(root, path)} exists but is not a directory.`);
      existing.push(path);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) continue;
      throw error;
    }
  }
  return existing;
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === code;
}

function displayPath(root: string, path: string): string {
  const shown = relative(root, path);
  return shown === "" ? "." : shown.replaceAll("\\", "/");
}

async function confirmInteractively(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(?:y|yes)$/iu.test((await prompt.question(`${question} [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}
