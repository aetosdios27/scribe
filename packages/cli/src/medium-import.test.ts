import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { MediumArchive, MediumArchivePost } from "./medium-archive.js";
import type { MediumAssetResult } from "./medium-assets.js";
import type { ConvertedMediumPost } from "./medium-convert.js";
import {
  applyMediumImportPlan,
  planMediumImport,
  type MediumImportDependencies
} from "./medium-import.js";

const fixtureRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...fixtureRoots].map((root) => rm(root, { force: true, recursive: true })));
  fixtureRoots.clear();
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scribe-medium-import-"));
  fixtureRoots.add(root);
  await writeFile(join(root, "medium-export.zip"), "fixture");
  return root;
}

function post(entryPath: string, status: MediumArchivePost["status"]): MediumArchivePost {
  return { entryPath, status, html: `<h1>${entryPath}</h1>` };
}

function converted(slug: string): ConvertedMediumPost {
  return {
    slug,
    kind: "story",
    markdown: `---\ntitle: "${slug}"\n---\n\n# ${slug}\n`,
    assets: [],
    warnings: []
  };
}

function dependencies(archive: MediumArchive): MediumImportDependencies {
  return {
    readArchive: vi.fn(async () => archive),
    convertPost: vi.fn(async (value) => converted(value.entryPath.split("/").at(-1)?.replace(/\.html$/u, "") ?? "post")),
    compile: vi.fn(async () => undefined),
    downloadAssets: vi.fn(async (plan): Promise<MediumAssetResult> => ({
      markdown: plan.markdown,
      createdFiles: [],
      warnings: []
    }))
  };
}

it("plans published stories only and detects the host content directory", async () => {
  const root = await workspace();
  await mkdir(join(root, "posts"));
  const deps = dependencies({
    posts: [post("posts/published.html", "published"), post("drafts/hidden.html", "draft")]
  });

  const plan = await planMediumImport(root, "medium-export.zip", {}, deps);

  expect(plan.contentDirectory).toBe(join(root, "posts"));
  expect(plan.articles.map((article) => article.slug)).toEqual(["published"]);
  expect(plan.availableDrafts).toBe(1);
  expect(plan.skippedDrafts).toBe(1);
  expect(deps.compile).toHaveBeenCalledOnce();
});

it("supports explicit draft and response inclusion", async () => {
  const root = await workspace();
  const deps = dependencies({
    posts: [
      post("posts/published.html", "published"),
      post("drafts/hidden.html", "draft"),
      post("posts/comment.html", "published")
    ]
  });
  vi.mocked(deps.convertPost!).mockImplementation(async (value) => (
    value.entryPath.includes("comment")
      ? { ...converted("comment"), kind: "response-candidate" }
      : converted(value.entryPath.includes("hidden") ? "hidden" : "published")
  ));

  const plan = await planMediumImport(root, "medium-export.zip", {
    includeDrafts: true,
    includeResponses: true,
    into: "writing"
  }, deps);

  expect(plan.articles.map((article) => article.slug)).toEqual(["published", "hidden", "comment"]);
  expect(plan.skippedDrafts).toBe(0);
  expect(plan.skippedResponseCandidates).toBe(0);
  expect(plan.articles.every((article) => article.targetPath.startsWith(join(root, "writing")))).toBe(true);
});

it("applies a planned import without overwriting existing articles", async () => {
  const root = await workspace();
  const deps = dependencies({ posts: [post("posts/published.html", "published")] });
  const plan = await planMediumImport(root, "medium-export.zip", {}, deps);

  await expect(applyMediumImportPlan(plan, deps)).resolves.toMatchObject({ articles: 1 });
  await expect(readFile(plan.articles[0]!.targetPath, "utf8")).resolves.toContain("# published");
  await expect(planMediumImport(root, "medium-export.zip", {}, deps)).rejects.toThrow("will not overwrite");
});

it("rolls back files created before a later article write fails", async () => {
  const root = await workspace();
  const deps = dependencies({
    posts: [post("posts/one.html", "published"), post("posts/two.html", "published")]
  });
  const plan = await planMediumImport(root, "medium-export.zip", {}, deps);
  let writes = 0;

  await expect(applyMediumImportPlan(plan, {
    writeArticle: async (path, source) => {
      writes += 1;
      if (writes === 2) throw new Error("disk full");
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, source, { flag: "wx" });
    }
  })).rejects.toThrow("rolled back");

  await expect(readdir(join(root, "content", "blog"))).rejects.toMatchObject({ code: "ENOENT" });
});
