import { access, mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { planInit, runInit } from "./init.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "scribe-workspace-init-"));
}

it("plans an empty content launchpad without generating an article", async () => {
  const cwd = await workspace();

  const plan = await planInit(cwd, {});

  expect(plan.contentDirectory).toBe(join(cwd, "content", "blog"));
  expect(plan.assetDirectory).toBeUndefined();
  expect(plan.directories).toEqual([join(cwd, "content", "blog")]);
  expect(await readdir(cwd)).toEqual([]);
});

it("reuses one existing content convention instead of creating a duplicate", async () => {
  const cwd = await workspace();
  await mkdir(join(cwd, "posts"), { recursive: true });

  const plan = await planInit(cwd, {});

  expect(plan.contentDirectory).toBe(join(cwd, "posts"));
  expect(plan.directories).toEqual([]);
});

it("requires an explicit directory when existing conventions are ambiguous", async () => {
  const cwd = await workspace();
  await mkdir(join(cwd, "posts"), { recursive: true });
  await mkdir(join(cwd, "content", "blog"), { recursive: true });
  const stderr = vi.fn();

  expect(await runInit(["--dry-run"], { cwd, stderr })).toBe(2);
  expect(stderr.mock.calls.join("\n")).toContain("--content-dir");
});

it("keeps dry runs pure and shows exactly what would be created", async () => {
  const cwd = await workspace();
  const stdout = vi.fn();

  expect(await runInit(["--dry-run", "--with-assets"], { cwd, stdout })).toBe(0);
  expect(await readdir(cwd)).toEqual([]);
  const output = stdout.mock.calls.join("\n");
  expect(output).toContain("content/blog");
  expect(output).toContain("content/assets");
  expect(output).toContain("No files will be generated");
});

it("creates only requested directories and remains idempotent", async () => {
  const cwd = await workspace();
  const stdout = vi.fn();

  expect(await runInit(["--yes", "--with-assets"], { cwd, stdout })).toBe(0);
  expect(await runInit(["--yes", "--with-assets"], { cwd, stdout })).toBe(0);
  expect((await readdir(join(cwd, "content"))).sort()).toEqual(["assets", "blog"]);
  expect((await readdir(join(cwd, "content", "blog"))).sort()).toEqual([]);
  expect((await readdir(join(cwd, "content", "assets"))).sort()).toEqual([]);
  const output = stdout.mock.calls.join("\n");
  expect(output).toContain("scribe studio content/blog/your-article.mdx");
  expect(output).not.toContain("<article>");
});

it("supports an explicit repository-relative content directory", async () => {
  const cwd = await workspace();

  expect(await runInit(["--content-dir", "writing/posts", "--yes"], { cwd, stdout: vi.fn() })).toBe(0);
  await expect(access(join(cwd, "writing", "posts"))).resolves.toBeUndefined();
});

it("refuses to treat a colliding file as a content directory", async () => {
  const cwd = await workspace();
  await mkdir(join(cwd, "content"), { recursive: true });
  await writeFile(join(cwd, "content", "blog"), "not a directory");
  const stderr = vi.fn();

  expect(await runInit(["--dry-run"], { cwd, stderr })).toBe(1);
  expect(stderr.mock.calls.join("\n")).toContain("content/blog exists but is not a directory");
  expect(stderr.mock.calls.join("\n")).not.toContain(cwd);
});

it("rejects paths outside the workspace and points old integration flags to integrate", async () => {
  const cwd = await workspace();
  const stderr = vi.fn();

  expect(await runInit(["--content-dir", "../elsewhere", "--yes"], { cwd, stderr })).toBe(2);
  expect(await runInit(["--mode", "tailwind"], { cwd, stderr })).toBe(2);
  const output = stderr.mock.calls.join("\n");
  expect(output).toContain("inside the current workspace");
  expect(output).toContain("scribe integrate --mode tailwind");
});
