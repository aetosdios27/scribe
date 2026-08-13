import { access, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { applyInitPlan, planInit } from "./init.js";

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

  await expect(planInit(cwd, {})).rejects.toThrow("--content-dir");
});

it("creates only requested directories and remains idempotent", async () => {
  const cwd = await workspace();
  await applyInitPlan(await planInit(cwd, { withAssets: true }));
  await applyInitPlan(await planInit(cwd, { withAssets: true }));

  expect((await readdir(join(cwd, "content"))).sort()).toEqual(["assets", "blog"]);
  expect(await readdir(join(cwd, "content", "blog"))).toEqual([]);
  expect(await readdir(join(cwd, "content", "assets"))).toEqual([]);
});

it("supports an explicit repository-relative content directory", async () => {
  const cwd = await workspace();
  await applyInitPlan(await planInit(cwd, { contentDirectory: "writing/posts" }));
  await expect(access(join(cwd, "writing", "posts"))).resolves.toBeUndefined();
});

it("refuses colliding files and paths outside the workspace", async () => {
  const cwd = await workspace();
  await mkdir(join(cwd, "content"), { recursive: true });
  await writeFile(join(cwd, "content", "blog"), "not a directory");

  await expect(planInit(cwd, {})).rejects.toThrow("content/blog exists but is not a directory");
  await expect(planInit(cwd, { contentDirectory: "../elsewhere" })).rejects.toThrow("inside the current workspace");
});
