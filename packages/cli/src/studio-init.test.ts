import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  createStudioArticle,
  deriveArticleSlug,
  planStudioArticle
} from "./studio-init.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "scribe-studio-init-"));
}

it("derives a readable article slug", () => {
  expect(deriveArticleSlug("The Smallest Honest Redis Clone")).toBe("the-smallest-honest-redis-clone");
  expect(deriveArticleSlug("  Déjà vu: cache & queue  ")).toBe("deja-vu-cache-queue");
});

it("creates a minimal article in the detected content directory", async () => {
  const cwd = await workspace();
  await mkdir(join(cwd, "posts"), { recursive: true });
  const plan = await planStudioArticle(cwd, { title: "The Smallest Honest Redis Clone" });

  await createStudioArticle(plan);

  expect(plan.targetPath).toBe(join(cwd, "posts", "the-smallest-honest-redis-clone.mdx"));
  await expect(readFile(plan.targetPath, "utf8")).resolves.toBe(
    '---\ntitle: "The Smallest Honest Redis Clone"\n---\n'
  );
});

it("respects explicit content directories, slugs, and paths", async () => {
  const cwd = await workspace();
  const slugPlan = await planStudioArticle(cwd, {
    title: "Cache Notes",
    slug: "redis-internals",
    contentDirectory: "writing"
  });
  expect(slugPlan.targetPath).toBe(join(cwd, "writing", "redis-internals.mdx"));

  await mkdir(join(cwd, "posts"), { recursive: true });
  await mkdir(join(cwd, "content", "blog"), { recursive: true });
  const pathPlan = await planStudioArticle(cwd, {
    title: "Explicit Target",
    path: "drafts/explicit-target.mdx"
  });
  await createStudioArticle(pathPlan);
  await expect(readFile(pathPlan.targetPath, "utf8")).resolves.toContain('title: "Explicit Target"');
});

it("refuses to overwrite an existing article", async () => {
  const cwd = await workspace();
  const path = join(cwd, "content", "blog", "existing.mdx");
  await mkdir(join(cwd, "content", "blog"), { recursive: true });
  await writeFile(path, "original\n");

  await expect(planStudioArticle(cwd, {
    title: "Existing",
    path: "content/blog/existing.mdx"
  })).rejects.toThrow("will not overwrite");
  await expect(readFile(path, "utf8")).resolves.toBe("original\n");
});

it("rejects invalid and unsafe targets before writing", async () => {
  const cwd = await workspace();
  await expect(planStudioArticle(cwd, {
    title: "Escape",
    path: "../escape.mdx"
  })).rejects.toThrow("inside the current workspace");
  await expect(access(join(cwd, "..", "escape.mdx"))).rejects.toMatchObject({ code: "ENOENT" });

  const outside = await workspace();
  await symlink(outside, join(cwd, "linked"));
  await expect(planStudioArticle(cwd, {
    title: "Linked",
    path: "linked/article.mdx"
  })).rejects.toThrow("symbolic link");
});
