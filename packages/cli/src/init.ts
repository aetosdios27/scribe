import { mkdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { chooseContentDirectory } from "./content-paths.js";

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

export async function applyInitPlan(plan: InitPlan): Promise<void> {
  for (const directory of plan.directories) await mkdir(directory, { recursive: true });
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


