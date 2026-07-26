import { chmod, lstat, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { durableWriteStudioFile, readStudioFile, StudioFileConflictError } from "./studio-files.js";

async function sourceFile(source = "# Original\n"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scribe durable "));
  const path = join(root, "article.mdx");
  await writeFile(path, source);
  return path;
}

it("durably replaces the resolved target without replacing a source symlink", async () => {
  const target = await sourceFile();
  await chmod(target, 0o664);
  const link = join(target, "..", "linked.mdx");
  await symlink(target, link);
  const snapshot = await readStudioFile(link);

  const committed = await durableWriteStudioFile({
    requestedPath: snapshot.requestedPath,
    resolvedPath: snapshot.resolvedPath,
    expectedVersion: snapshot.version,
    expectedDevice: snapshot.device,
    expectedInode: snapshot.inode,
    lineEnding: snapshot.lineEnding,
    bom: snapshot.bom,
    mode: snapshot.mode,
    source: "# Saved\n"
  });

  expect((await lstat(link)).isSymbolicLink()).toBe(true);
  expect(await readFile(target, "utf8")).toBe("# Saved\n");
  expect(committed.source).toBe("# Saved\n");
  expect((await lstat(target)).mode & 0o777).toBe(0o664);
});

it("detects an edit in the final commit window and removes its temporary file", async () => {
  const path = await sourceFile();
  const snapshot = await readStudioFile(path);

  await expect(durableWriteStudioFile({
    requestedPath: snapshot.requestedPath,
    resolvedPath: snapshot.resolvedPath,
    expectedVersion: snapshot.version,
    expectedDevice: snapshot.device,
    expectedInode: snapshot.inode,
    lineEnding: snapshot.lineEnding,
    bom: snapshot.bom,
    mode: snapshot.mode,
    source: "# Studio\n",
    beforeCommit: async () => writeFile(path, "# External\n")
  })).rejects.toBeInstanceOf(StudioFileConflictError);

  expect(await readFile(path, "utf8")).toBe("# External\n");
  const directory = await readdir(join(path, ".."));
  expect(directory.some((name) => name.includes(".scribe-") && name.endsWith(".tmp"))).toBe(false);
});

it("preserves a UTF-8 BOM and CRLF line endings", async () => {
  const path = await sourceFile("\uFEFF# Original\r\n\r\nBody.\r\n");
  const snapshot = await readStudioFile(path);
  expect(snapshot).toMatchObject({ bom: true, lineEnding: "\r\n", source: "# Original\r\n\r\nBody.\r\n" });

  await durableWriteStudioFile({
    requestedPath: snapshot.requestedPath,
    resolvedPath: snapshot.resolvedPath,
    expectedVersion: snapshot.version,
    expectedDevice: snapshot.device,
    expectedInode: snapshot.inode,
    lineEnding: snapshot.lineEnding,
    bom: snapshot.bom,
    mode: snapshot.mode,
    source: "# Saved\n\nBody.\n"
  });
  expect(await readFile(path, "utf8")).toBe("\uFEFF# Saved\r\n\r\nBody.\r\n");
});

it("refuses mixed line endings instead of silently normalizing them", async () => {
  const path = await sourceFile("# Mixed\r\n\nBody\r\n");
  await expect(readStudioFile(path)).rejects.toThrow("mixed LF and CRLF");
});

it("refuses bare carriage returns instead of silently normalizing them", async () => {
  const path = await sourceFile("# Legacy\r\rBody\r");
  await expect(readStudioFile(path)).rejects.toThrow("bare carriage returns");
});

it("rejects non-regular sources before attempting to read them", async () => {
  const root = await mkdtemp(join(tmpdir(), "scribe source directory "));
  await expect(readStudioFile(root)).rejects.toThrow("Studio source is not a regular file");
});
