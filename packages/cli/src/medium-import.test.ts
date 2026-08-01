import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterEach, expect, it, vi } from "vitest";

import type { MediumArchive, MediumArchivePost } from "./medium-archive.js";
import type { MediumAssetResult } from "./medium-assets.js";
import type { ConvertedMediumPost } from "./medium-convert.js";
import {
  planMediumImport,
  runMediumImport,
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

function responseCandidate(slug: string): ConvertedMediumPost {
  return { ...converted(slug), kind: "response-candidate" };
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

async function tree(root: string): Promise<unknown> {
  const entries = (await readdir(root, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  return Promise.all(entries.map(async (entry) => ({
    name: entry.name,
    ...(entry.isDirectory()
      ? { children: await tree(join(root, entry.name)) }
      : { contents: await readFile(join(root, entry.name), "utf8") })
  })));
}

it("plans published stories only by default and detects the host content directory", async () => {
  const root = await workspace();
  await mkdir(join(root, "posts"));
  const archive = {
    posts: [post("posts/published.html", "published"), post("drafts/hidden.html", "draft")]
  } satisfies MediumArchive;
  const deps = dependencies(archive);

  const plan = await planMediumImport(root, "medium-export.zip", {}, deps);

  expect(plan.contentDirectory).toBe(join(root, "posts"));
  expect(plan.articles.map((article) => article.slug)).toEqual(["published"]);
  expect(plan.availableDrafts).toBe(1);
  expect(plan.skippedDrafts).toBe(1);
  expect(plan.articles[0]?.targetPath).toBe(join(root, "posts", "published.mdx"));
  expect(deps.compile).toHaveBeenCalledOnce();
});

it("supports explicit draft inclusion and an explicit destination", async () => {
  const root = await workspace();
  const archive = {
    posts: [post("posts/published.html", "published"), post("drafts/hidden.html", "draft")]
  } satisfies MediumArchive;
  const deps = dependencies(archive);

  const plan = await planMediumImport(root, "medium-export.zip", {
    includeDrafts: true,
    into: "writing"
  }, deps);

  expect(plan.articles.map((article) => article.slug)).toEqual(["published", "hidden"]);
  expect(plan.skippedDrafts).toBe(0);
  expect(plan.articles.every((article) => article.targetPath.startsWith(join(root, "writing")))).toBe(true);
});

it("skips response-shaped entries by default while reporting them separately", async () => {
  const root = await workspace();
  const archive = {
    posts: [post("posts/article.html", "published"), post("posts/comment.html", "published")]
  } satisfies MediumArchive;
  const deps = dependencies(archive);
  vi.mocked(deps.convertPost!).mockImplementation(async (value) => (
    value.entryPath.includes("comment") ? responseCandidate("comment") : converted("article")
  ));

  const plan = await planMediumImport(root, "medium-export.zip", {}, deps);

  expect(plan.articles.map((article) => article.slug)).toEqual(["article"]);
  expect(plan.availableResponseCandidates).toBe(1);
  expect(plan.skippedResponseCandidates).toBe(1);
});

it("can explicitly include response-shaped entries", async () => {
  const root = await workspace();
  const archive = {
    posts: [post("posts/article.html", "published"), post("posts/comment.html", "published")]
  } satisfies MediumArchive;
  const deps = dependencies(archive);
  vi.mocked(deps.convertPost!).mockImplementation(async (value) => (
    value.entryPath.includes("comment") ? responseCandidate("comment") : converted("article")
  ));

  const plan = await planMediumImport(root, "medium-export.zip", { includeResponses: true }, deps);

  expect(plan.articles.map((article) => article.slug)).toEqual(["article", "comment"]);
  expect(plan.skippedResponseCandidates).toBe(0);
});

it("keeps dry runs byte-for-byte pure and performs no asset requests", async () => {
  const root = await workspace();
  const archive = { posts: [post("posts/published.html", "published")] } satisfies MediumArchive;
  const deps = dependencies(archive);
  const confirm = vi.fn();
  const before = await tree(root);

  expect(await runMediumImport(["medium-export.zip", "--dry-run"], {
    ...deps,
    cwd: root,
    stdout: vi.fn(),
    confirm
  })).toBe(0);

  expect(await tree(root)).toEqual(before);
  expect(deps.downloadAssets).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
});

it("asks separately about drafts, asset downloads, and the final mutation", async () => {
  const root = await workspace();
  const archive = {
    posts: [post("posts/published.html", "published"), post("drafts/hidden.html", "draft")]
  } satisfies MediumArchive;
  const deps = dependencies(archive);
  vi.mocked(deps.convertPost!).mockImplementation(async (value) => ({
    ...converted(value.entryPath.includes("hidden") ? "hidden" : "published"),
    assets: [{
      originalUrl: new URL("https://miro.medium.com/image.png"),
      alt: "Image",
      articleReference: "https://miro.medium.com/image.png"
    }]
  }));
  const confirm = vi.fn()
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);

  expect(await runMediumImport(["medium-export.zip"], {
    ...deps,
    cwd: root,
    stdout: vi.fn(),
    confirm
  })).toBe(0);

  expect(confirm.mock.calls).toEqual([
    ["Include 1 unpublished Medium draft?", false],
    ["Download referenced Medium images locally?", true],
    ["Import 2 Medium stories?", false]
  ]);
  expect(deps.downloadAssets).not.toHaveBeenCalled();
  await expect(access(join(root, "content", "blog", "published.mdx"))).resolves.toBeUndefined();
  await expect(access(join(root, "content", "blog", "hidden.mdx"))).resolves.toBeUndefined();
});

it("does not ask about asset downloads when selected stories contain no images", async () => {
  const root = await workspace();
  const archive = { posts: [post("posts/published.html", "published")] } satisfies MediumArchive;
  const deps = dependencies(archive);
  const confirm = vi.fn().mockResolvedValue(true);
  const stdout = vi.fn();

  expect(await runMediumImport(["medium-export.zip"], {
    ...deps,
    cwd: root,
    stdout,
    confirm
  })).toBe(0);

  expect(confirm.mock.calls).toEqual([["Import 1 Medium story?", false]]);
  expect(stdout.mock.calls.join("\n")).toContain("Drafts   none in export");
});

it("--yes accepts safe defaults but does not silently import drafts", async () => {
  const root = await workspace();
  const archive = {
    posts: [post("posts/published.html", "published"), post("drafts/hidden.html", "draft")]
  } satisfies MediumArchive;
  const deps = dependencies(archive);
  vi.mocked(deps.convertPost!).mockResolvedValue({
    ...converted("published"),
    assets: [{
      originalUrl: new URL("https://miro.medium.com/image.png"),
      alt: "Image",
      articleReference: "https://miro.medium.com/image.png"
    }]
  });

  expect(await runMediumImport(["medium-export.zip", "--yes"], {
    ...deps,
    cwd: root,
    stdout: vi.fn(),
    confirm: vi.fn()
  })).toBe(0);

  expect(deps.downloadAssets).toHaveBeenCalledOnce();
  await expect(access(join(root, "content", "blog", "published.mdx"))).resolves.toBeUndefined();
  await expect(access(join(root, "content", "blog", "hidden.mdx"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("honors --include-drafts and --no-download-assets without prompting", async () => {
  const root = await workspace();
  const archive = {
    posts: [post("posts/published.html", "published"), post("drafts/hidden.html", "draft")]
  } satisfies MediumArchive;
  const deps = dependencies(archive);

  expect(await runMediumImport([
    "medium-export.zip",
    "--include-drafts",
    "--no-download-assets",
    "--yes"
  ], { ...deps, cwd: root, stdout: vi.fn() })).toBe(0);

  expect(deps.downloadAssets).not.toHaveBeenCalled();
  await expect(access(join(root, "content", "blog", "published.mdx"))).resolves.toBeUndefined();
  await expect(access(join(root, "content", "blog", "hidden.mdx"))).resolves.toBeUndefined();
});

it("refuses an existing target before mutation", async () => {
  const root = await workspace();
  await mkdir(join(root, "content", "blog"), { recursive: true });
  await writeFile(join(root, "content", "blog", "same.mdx"), "existing");
  const archive = {
    posts: [post("posts/first.html", "published"), post("posts/second.html", "published")]
  } satisfies MediumArchive;
  const deps = dependencies(archive);
  vi.mocked(deps.convertPost!).mockResolvedValue(converted("same"));
  const stderr = vi.fn();

  expect(await runMediumImport(["medium-export.zip", "--yes"], {
    ...deps,
    cwd: root,
    stderr,
    stdout: vi.fn()
  })).toBe(1);

  expect(stderr.mock.calls.join("\n")).toContain("content/blog/same.mdx already exists");
  expect(await readFile(join(root, "content", "blog", "same.mdx"), "utf8")).toBe("existing");
  expect(deps.downloadAssets).not.toHaveBeenCalled();
});

it("refuses duplicate generated slugs before mutation", async () => {
  const root = await workspace();
  const archive = {
    posts: [post("posts/first.html", "published"), post("posts/second.html", "published")]
  } satisfies MediumArchive;
  const deps = dependencies(archive);
  vi.mocked(deps.convertPost!).mockResolvedValue(converted("same"));
  const stderr = vi.fn();

  expect(await runMediumImport(["medium-export.zip", "--yes"], {
    ...deps,
    cwd: root,
    stderr,
    stdout: vi.fn()
  })).toBe(1);

  expect(stderr.mock.calls.join("\n")).toContain('duplicate slug "same"');
  await expect(access(join(root, "content"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(deps.downloadAssets).not.toHaveBeenCalled();
});

it("compiles every converted story before writing any files", async () => {
  const root = await workspace();
  const archive = {
    posts: [post("posts/first.html", "published"), post("posts/second.html", "published")]
  } satisfies MediumArchive;
  const deps = dependencies(archive);
  vi.mocked(deps.compile!).mockRejectedValueOnce(new Error("invalid article"));

  expect(await runMediumImport(["medium-export.zip", "--yes"], {
    ...deps,
    cwd: root,
    stdout: vi.fn(),
    stderr: vi.fn()
  })).toBe(1);

  await expect(access(join(root, "content"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(deps.downloadAssets).not.toHaveBeenCalled();
});

it("rolls back only files created by the import when a later article write fails", async () => {
  const root = await workspace();
  const archive = {
    posts: [post("posts/first.html", "published"), post("posts/second.html", "published")]
  } satisfies MediumArchive;
  const deps = dependencies(archive);
  let writes = 0;

  expect(await runMediumImport(["medium-export.zip", "--yes"], {
    ...deps,
    cwd: root,
    stdout: vi.fn(),
    stderr: vi.fn(),
    writeArticle: async (path, source) => {
      writes += 1;
      if (writes === 2) throw new Error("disk full");
      await mkdir(join(root, "content", "blog"), { recursive: true });
      await writeFile(path, source, { flag: "wx" });
    }
  })).toBe(1);

  await expect(access(join(root, "content", "blog", "first.mdx"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(join(root, "content", "blog", "second.mdx"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(join(root, "content"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves pre-existing empty target directories during rollback", async () => {
  const root = await workspace();
  const target = join(root, "content", "blog");
  await mkdir(target, { recursive: true });
  const archive = {
    posts: [post("posts/first.html", "published"), post("posts/second.html", "published")]
  } satisfies MediumArchive;
  const deps = dependencies(archive);
  let writes = 0;

  expect(await runMediumImport(["medium-export.zip", "--yes"], {
    ...deps,
    cwd: root,
    stdout: vi.fn(),
    stderr: vi.fn(),
    writeArticle: async (path, source) => {
      writes += 1;
      if (writes === 2) throw new Error("disk full");
      await writeFile(path, source, { flag: "wx" });
    }
  })).toBe(1);

  await expect(access(target)).resolves.toBeUndefined();
  expect(await readdir(target)).toEqual([]);
});

it("returns usage exit code 2 for malformed invocations", async () => {
  const stderr = vi.fn();

  expect(await runMediumImport([], { stderr })).toBe(2);
  expect(await runMediumImport(["one.zip", "two.zip"], { stderr })).toBe(2);
  expect(await runMediumImport(["one.zip", "--wat"], { stderr })).toBe(2);
  expect(stderr.mock.calls.join("\n")).toContain("Usage");
});

it.runIf(process.platform !== "win32")("refuses to write through a symlinked content convention", async () => {
  const root = await workspace();
  const outside = await mkdtemp(join(tmpdir(), "scribe-medium-outside-"));
  fixtureRoots.add(outside);
  await mkdir(join(root, "content"));
  await symlink(outside, join(root, "content", "blog"), "dir");
  const archive = { posts: [post("posts/published.html", "published")] } satisfies MediumArchive;
  const stderr = vi.fn();

  expect(await runMediumImport(["medium-export.zip", "--yes"], {
    ...dependencies(archive),
    cwd: root,
    stdout: vi.fn(),
    stderr
  })).toBe(1);

  expect(stderr.mock.calls.join("\n")).toContain("symbolic link");
  expect(await readdir(outside)).toEqual([]);
});

it("imports a real ZIP through the archive, conversion, and MDX compilation pipeline", async () => {
  const root = await workspace();
  const archive = zipSync({
    "medium-export/posts/2026-07-31_peer-wire.html": strToU8(`<!doctype html>
      <html>
        <head>
          <title>Peer wire field notes</title>
          <meta name="description" content="A practical protocol walk-through">
        </head>
        <body>
          <article>
            <h1>Peer wire field notes</h1>
            <p>A practical protocol walk-through</p>
            <h2>Handshake</h2>
            <p>The first <code>68</code> bytes establish the session.</p>
          </article>
        </body>
      </html>`)
  });
  await writeFile(join(root, "medium-export.zip"), archive);

  expect(await runMediumImport([
    "medium-export.zip",
    "--no-download-assets",
    "--yes"
  ], { cwd: root, stdout: vi.fn(), stderr: vi.fn() })).toBe(0);

  const source = await readFile(join(root, "content", "blog", "peer-wire.mdx"), "utf8");
  expect(source).toContain('title: "Peer wire field notes"');
  expect(source).toContain("## Handshake");
  expect(source).not.toContain("<script");
});
