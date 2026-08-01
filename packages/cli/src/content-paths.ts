import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const contentConventions = ["content/blog", "content/blogs", "posts", "src/content"] as const;

export class ContentPathUsageError extends Error {}

export function displayWorkspacePath(root: string, path: string): string {
  const shown = relative(root, path);
  return shown === "" ? "." : shown.replaceAll("\\", "/");
}

export function resolveInsideWorkspace(root: string, input: string, option: string): string {
  if (input.length === 0 || isAbsolute(input)) {
    throw new ContentPathUsageError(`${option} must point inside the current workspace.`);
  }
  const path = resolve(root, input);
  const fromRoot = relative(root, path);
  if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new ContentPathUsageError(`${option} must point inside the current workspace.`);
  }
  return path;
}

export async function chooseContentDirectory(
  rootInput: string,
  explicitDirectory: string | undefined,
  option: string
): Promise<string> {
  const root = resolve(rootInput);
  if (explicitDirectory !== undefined) {
    const explicit = resolveInsideWorkspace(root, explicitDirectory, option);
    await assertDirectoryOrMissing(root, explicit);
    return explicit;
  }
  const detected: string[] = [];
  for (const convention of contentConventions) {
    const path = resolve(root, convention);
    if (await assertDirectoryOrMissing(root, path)) detected.push(path);
  }
  if (detected.length > 1) {
    throw new ContentPathUsageError(
      `Multiple content directories already exist: ${detected.map((path) => displayWorkspacePath(root, path)).join(", ")}. Choose one with ${option}.`
    );
  }
  return detected[0] ?? resolve(root, "content/blog");
}

export async function assertNoSymbolicLinkComponents(rootInput: string, pathInput: string): Promise<void> {
  const root = resolve(rootInput);
  const path = resolve(pathInput);
  const fromRoot = relative(root, path);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new ContentPathUsageError("Path must point inside the current workspace.");
  }
  let current = root;
  for (const segment of fromRoot.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error(`${displayWorkspacePath(root, current)} is a symbolic link; Scribe will not write through it.`);
      }
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return;
      throw error;
    }
  }
}

async function assertDirectoryOrMissing(root: string, path: string): Promise<boolean> {
  await assertNoSymbolicLinkComponents(root, path);
  try {
    const info = await lstat(path);
    if (!info.isDirectory()) throw new Error(`${displayWorkspacePath(root, path)} exists but is not a directory.`);
    return true;
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
