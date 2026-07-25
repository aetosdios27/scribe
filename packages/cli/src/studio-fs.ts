import { open } from "node:fs/promises";

export async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch (error) {
    if (!isUnsupportedWindowsDirectorySync(error)) throw error;
  } finally {
    await directory?.close();
  }
}

function isUnsupportedWindowsDirectorySync(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EINVAL" || code === "ENOTSUP" || code === "EPERM";
}
