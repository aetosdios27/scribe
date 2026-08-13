import { access, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { deriveArticleSlug, runStudioInit } from "./studio-init.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "scribe-studio-init-"));
}

it("derives a readable article slug", () => {
  expect(deriveArticleSlug("The Smallest Honest Redis Clone")).toBe("the-smallest-honest-redis-clone");
  expect(deriveArticleSlug("  Déjà vu: cache & queue  ")).toBe("deja-vu-cache-queue");
});

it("creates a minimal article in the detected content directory and launches normal Studio", async () => {
  const cwd = await workspace();
  await mkdir(join(cwd, "posts"), { recursive: true });
  const launchStudio = vi.fn(async (_args: readonly string[]) => 0);
  const stdout = vi.fn();

  expect(await runStudioInit([
    "--title", "The Smallest Honest Redis Clone", "--yes", "--no-open"
  ], { cwd, stdout, launchStudio })).toBe(0);

  const path = join(cwd, "posts", "the-smallest-honest-redis-clone.mdx");
  await expect(readFile(path, "utf8")).resolves.toBe(
    '---\ntitle: "The Smallest Honest Redis Clone"\n---\n'
  );
  expect(launchStudio).toHaveBeenCalledOnce();
  expect(launchStudio.mock.calls[0]?.[0]).toEqual([
    "posts/the-smallest-honest-redis-clone.mdx",
    "--no-open"
  ]);
  expect(stdout.mock.calls.join("\n")).toContain("Opening Scribe Studio");
});

it("respects an explicit content directory and editable slug and path", async () => {
  const cwd = await workspace();
  const launchStudio = vi.fn(async (_args: readonly string[]) => 0);

  expect(await runStudioInit([
    "--content-dir", "writing",
    "--title", "Cache Notes",
    "--slug", "redis-internals",
    "--path", "writing/deep/redis.mdx",
    "--yes"
  ], { cwd, stdout: vi.fn(), launchStudio })).toBe(0);

  await expect(readFile(join(cwd, "writing", "deep", "redis.mdx"), "utf8"))
    .resolves.toContain('title: "Cache Notes"');
  expect(launchStudio.mock.calls[0]?.[0]?.[0]).toBe("writing/deep/redis.mdx");
});

it("refuses to overwrite an existing article", async () => {
  const cwd = await workspace();
  const path = join(cwd, "content", "blog", "existing.mdx");
  await mkdir(join(cwd, "content", "blog"), { recursive: true });
  await writeFile(path, "original\n");
  const stderr = vi.fn();
  const launchStudio = vi.fn(async (_args: readonly string[]) => 0);

  expect(await runStudioInit([
    "--title", "Existing", "--path", "content/blog/existing.mdx", "--yes"
  ], { cwd, stderr, stdout: vi.fn(), launchStudio })).toBe(1);

  await expect(readFile(path, "utf8")).resolves.toBe("original\n");
  expect(stderr.mock.calls.join("\n")).toContain("will not overwrite");
  expect(launchStudio).not.toHaveBeenCalled();
});

it("writes nothing when title entry or final confirmation is cancelled", async () => {
  const titleCancelled = await workspace();
  expect(await runStudioInit([], {
    cwd: titleCancelled,
    stdout: vi.fn(),
    prompt: async () => null,
    confirm: async () => true,
    launchStudio: vi.fn(async (_args: readonly string[]) => 0)
  })).toBe(0);
  expect(await readdir(titleCancelled)).toEqual([]);

  const confirmationCancelled = await workspace();
  expect(await runStudioInit(["--title", "No Write"], {
    cwd: confirmationCancelled,
    stdout: vi.fn(),
    confirm: async () => false,
    launchStudio: vi.fn(async (_args: readonly string[]) => 0)
  })).toBe(0);
  expect(await readdir(confirmationCancelled)).toEqual([]);
});

it("rejects paths outside the project and unsafe symbolic-link targets", async () => {
  const cwd = await workspace();
  const stderr = vi.fn();
  const launchStudio = vi.fn(async (_args: readonly string[]) => 0);

  expect(await runStudioInit([
    "--title", "Escape", "--path", "../escape.mdx", "--yes"
  ], { cwd, stderr, stdout: vi.fn(), launchStudio })).toBe(2);
  await expect(access(join(cwd, "..", "escape.mdx"))).rejects.toMatchObject({ code: "ENOENT" });

  const outside = await workspace();
  await symlink(outside, join(cwd, "linked"));
  expect(await runStudioInit([
    "--title", "Linked", "--path", "linked/article.mdx", "--yes"
  ], { cwd, stderr, stdout: vi.fn(), launchStudio })).toBe(1);
  expect(stderr.mock.calls.join("\n")).toContain("symbolic link");
  expect(launchStudio).not.toHaveBeenCalled();
});
