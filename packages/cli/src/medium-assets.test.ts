import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { MediumAssetReference } from "./medium-convert.js";
import { downloadMediumAssets } from "./medium-assets.js";

const fixtureRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...fixtureRoots].map((root) => rm(root, { force: true, recursive: true })));
  fixtureRoots.clear();
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scribe-medium-assets-"));
  fixtureRoots.add(root);
  return root;
}

function asset(url: string, alt = "Peer wire"): MediumAssetReference {
  return { originalUrl: new URL(url), alt, articleReference: url };
}

function imageResponse(bytes = new Uint8Array([1, 2, 3]), type = "image/png"): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": type } });
}

it("downloads an image into a deterministic public path and rewrites Markdown", async () => {
  const root = await workspace();
  const reference = asset("https://cdn-images-1.medium.com/max/1200/peer-wire.png");
  const fetch = vi.fn<typeof globalThis.fetch>(async () => imageResponse());

  const result = await downloadMediumAssets({
    root,
    slug: "peer-wire",
    markdown: `![${reference.alt}](${reference.articleReference})`,
    assets: [reference]
  }, { fetch });

  expect(fetch).toHaveBeenCalledOnce();
  expect(result.markdown).toBe("![Peer wire](/scribe-imports/peer-wire/peer-wire.png)");
  expect(result.createdFiles).toEqual([join(root, "public", "scribe-imports", "peer-wire", "peer-wire.png")]);
  expect(await readFile(result.createdFiles[0] as string)).toEqual(Buffer.from([1, 2, 3]));
  expect(result.warnings).toEqual([]);
});

it.runIf(process.platform !== "win32")("refuses to write assets through a symlinked public directory", async () => {
  const root = await workspace();
  const outside = await workspace();
  await symlink(outside, join(root, "public"), "dir");
  const reference = asset("https://miro.medium.com/image.png");

  await expect(downloadMediumAssets({
    root,
    slug: "peer-wire",
    markdown: reference.articleReference,
    assets: [reference]
  }, {
    fetch: vi.fn(async () => imageResponse())
  })).rejects.toThrow(/symbolic link/iu);
  expect(await readdir(outside)).toEqual([]);
});

it("deduplicates repeated URLs and gives colliding filenames distinct paths", async () => {
  const root = await workspace();
  const first = asset("https://cdn-images-1.medium.com/a/image.png", "First");
  const duplicate = asset("https://cdn-images-1.medium.com/a/image.png", "Again");
  const collision = asset("https://miro.medium.com/b/image.png", "Second");
  const fetch = vi.fn<typeof globalThis.fetch>(async () => imageResponse());

  const result = await downloadMediumAssets({
    root,
    slug: "collisions",
    markdown: [first, duplicate, collision].map((item) => `![${item.alt}](${item.articleReference})`).join("\n"),
    assets: [first, duplicate, collision]
  }, { fetch });

  expect(fetch).toHaveBeenCalledTimes(2);
  expect(result.createdFiles.map((path) => path.split("/").at(-1))).toEqual(["image.png", "image-2.png"]);
  expect(result.markdown).toContain("![First](/scribe-imports/collisions/image.png)");
  expect(result.markdown).toContain("![Again](/scribe-imports/collisions/image.png)");
  expect(result.markdown).toContain("![Second](/scribe-imports/collisions/image-2.png)");
});

it("follows bounded HTTPS redirects and rejects insecure redirect targets", async () => {
  const root = await workspace();
  const safe = asset("https://cdn-images-1.medium.com/redirect.png");
  const unsafe = asset("https://miro.medium.com/unsafe.png");
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/redirect.png")) {
      return new Response(null, { status: 302, headers: { location: "https://miro.medium.com/final.png" } });
    }
    if (url.endsWith("/unsafe.png")) {
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private.png" } });
    }
    return imageResponse();
  });

  const result = await downloadMediumAssets({
    root,
    slug: "redirects",
    markdown: `${safe.articleReference}\n${unsafe.articleReference}`,
    assets: [safe, unsafe]
  }, { fetch });

  expect(result.markdown).toContain("/scribe-imports/redirects/redirect.png");
  expect(result.markdown).toContain(unsafe.articleReference);
  expect(result.warnings).toEqual([
    expect.objectContaining({ code: "medium-asset-download-failed", source: unsafe.articleReference })
  ]);
});

it.each([
  {
    name: "HTTP errors",
    fetch: async () => new Response("missing", { status: 404 }),
    message: /HTTP 404/iu
  },
  {
    name: "unsupported MIME types",
    fetch: async () => imageResponse(new Uint8Array([1]), "image/svg+xml"),
    message: /image\/svg\+xml/iu
  },
  {
    name: "byte limits",
    fetch: async () => imageResponse(new Uint8Array(32)),
    message: /more than 8 bytes/iu
  }
])("preserves the remote URL when $name prevent a safe download", async ({ fetch: fetchImplementation, message }) => {
  const root = await workspace();
  const reference = asset("https://cdn-images-1.medium.com/image.png");

  const result = await downloadMediumAssets({
    root,
    slug: "fallback",
    markdown: reference.articleReference,
    assets: [reference],
    maximumAssetBytes: 8
  }, { fetch: vi.fn(fetchImplementation) as typeof globalThis.fetch });

  expect(result.markdown).toBe(reference.articleReference);
  expect(result.createdFiles).toEqual([]);
  expect(result.warnings[0]?.message).toMatch(message);
});

it("times out a stalled request and leaves the remote URL intact", async () => {
  const root = await workspace();
  const reference = asset("https://cdn-images-1.medium.com/stalled.png");
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })
  );

  const result = await downloadMediumAssets({
    root,
    slug: "timeout",
    markdown: reference.articleReference,
    assets: [reference],
    requestTimeoutMilliseconds: 5
  }, { fetch });

  expect(result.markdown).toBe(reference.articleReference);
  expect(result.warnings[0]?.message).toMatch(/timed out/iu);
});

it("never overwrites an existing asset", async () => {
  const root = await workspace();
  const directory = join(root, "public", "scribe-imports", "peer-wire");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "peer-wire.png"), "original");
  const reference = asset("https://cdn-images-1.medium.com/peer-wire.png");

  const result = await downloadMediumAssets({
    root,
    slug: "peer-wire",
    markdown: reference.articleReference,
    assets: [reference]
  }, { fetch: vi.fn(async () => imageResponse()) });

  expect(await readFile(join(directory, "peer-wire.png"), "utf8")).toBe("original");
  expect(result.createdFiles).toEqual([join(directory, "peer-wire-2.png")]);
});

it("performs no network or filesystem writes during a dry run", async () => {
  const root = await workspace();
  const reference = asset("https://cdn-images-1.medium.com/peer-wire.png");
  const fetch = vi.fn<typeof globalThis.fetch>();

  const result = await downloadMediumAssets({
    root,
    slug: "dry-run",
    markdown: reference.articleReference,
    assets: [reference],
    dryRun: true
  }, { fetch });

  expect(fetch).not.toHaveBeenCalled();
  expect(result).toMatchObject({ markdown: reference.articleReference, createdFiles: [], warnings: [] });
  await expect(access(join(root, "public"))).rejects.toThrow();
});
