import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterEach, expect, it } from "vitest";

import { readMediumArchive } from "./medium-archive.js";

const fixtureRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...fixtureRoots].map((root) => rm(root, { force: true, recursive: true })));
  fixtureRoots.clear();
});

async function archivePath(entries: Record<string, string>, mutate?: (archive: Uint8Array) => void): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scribe-medium-archive-"));
  fixtureRoots.add(root);
  const archive = zipSync(Object.fromEntries(
    Object.entries(entries).map(([path, value]) => [path, strToU8(value)])
  ));
  mutate?.(archive);
  const path = join(root, "medium-export.zip");
  await writeFile(path, archive);
  return path;
}

function forEachSignature(archive: Uint8Array, signature: number, visit: (offset: number) => void): void {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  for (let offset = 0; offset <= archive.byteLength - 4; offset += 1) {
    if (view.getUint32(offset, true) === signature) visit(offset);
  }
}

it("discovers published stories, filename-prefixed drafts, nested export roots, and UTF-8 paths", async () => {
  const path = await archivePath({
    "medium-export/posts/2026-07-30_peer-wire.html": "<h1>Peer wire</h1>",
    "medium-export/posts/Draft_2026-07-31_नोट्स.html": "<h1>Notes</h1>",
    "medium-export/bookmarks/bookmarks.html": "<p>Not a story</p>"
  });

  await expect(readMediumArchive(path)).resolves.toEqual({
    posts: [
      {
        entryPath: "medium-export/posts/2026-07-30_peer-wire.html",
        html: "<h1>Peer wire</h1>",
        status: "published"
      },
      {
        entryPath: "medium-export/posts/Draft_2026-07-31_नोट्स.html",
        html: "<h1>Notes</h1>",
        status: "draft"
      }
    ]
  });
});

it.each([
  ["parent traversal", "../posts/story.html"],
  ["backslash traversal", "..\\posts\\story.html"],
  ["absolute POSIX path", "/posts/story.html"],
  ["absolute Windows path", "C:\\posts\\story.html"]
])("rejects %s archive entries", async (_label, entryPath) => {
  const path = await archivePath({ [entryPath]: "<h1>Unsafe</h1>" });

  await expect(readMediumArchive(path)).rejects.toThrow(/unsafe archive path/iu);
});

it("rejects encrypted entries before decompression", async () => {
  const path = await archivePath({ "posts/story.html": "<h1>Encrypted</h1>" }, (archive) => {
    forEachSignature(archive, 0x04034b50, (offset) => {
      archive[offset + 6] = (archive[offset + 6] ?? 0) | 1;
    });
    forEachSignature(archive, 0x02014b50, (offset) => {
      archive[offset + 8] = (archive[offset + 8] ?? 0) | 1;
    });
  });

  await expect(readMediumArchive(path)).rejects.toThrow(/encrypted ZIP entries are not supported/iu);
});

it("rejects unsupported compression methods before decompression", async () => {
  const path = await archivePath({ "posts/story.html": "<h1>Compressed</h1>" }, (archive) => {
    forEachSignature(archive, 0x04034b50, (offset) => {
      archive[offset + 8] = 12;
      archive[offset + 9] = 0;
    });
    forEachSignature(archive, 0x02014b50, (offset) => {
      archive[offset + 10] = 12;
      archive[offset + 11] = 0;
    });
  });

  await expect(readMediumArchive(path)).rejects.toThrow(/compression method 12/iu);
});

it("enforces entry-count and uncompressed-byte limits before extraction", async () => {
  const path = await archivePath({
    "posts/one.html": "12345",
    "posts/two.html": "67890"
  });

  await expect(readMediumArchive(path, { maximumEntries: 1 })).rejects.toThrow(/more than 1 entries/iu);
  await expect(readMediumArchive(path, { maximumEntryBytes: 4 })).rejects.toThrow(/larger than 4 bytes/iu);
  await expect(readMediumArchive(path, { maximumUncompressedBytes: 9 })).rejects.toThrow(/more than 9 uncompressed bytes/iu);
});

it("does not trust declared sizes while decompressing entries", async () => {
  const path = await archivePath({ "posts/story.html": "x".repeat(4096) }, (archive) => {
    forEachSignature(archive, 0x02014b50, (offset) => {
      new DataView(archive.buffer, archive.byteOffset, archive.byteLength).setUint32(offset + 24, 1, true);
    });
  });

  await expect(readMediumArchive(path, { maximumEntryBytes: 64 })).rejects.toThrow(/expanded beyond 64 bytes/iu);
});

it("rejects duplicate normalized archive paths", async () => {
  const path = await archivePath({
    "posts/a.html": "<h1>One</h1>",
    "posts/b.html": "<h1>Two</h1>"
  }, (archive) => {
    const from = new TextEncoder().encode("posts/b.html");
    const to = new TextEncoder().encode("posts/a.html");
    for (let offset = 0; offset <= archive.byteLength - from.length; offset += 1) {
      if (from.every((byte, index) => archive[offset + index] === byte)) archive.set(to, offset);
    }
  });

  await expect(readMediumArchive(path)).rejects.toThrow(/duplicate archive path "posts\/a\.html"/iu);
});

it("rejects malformed and non-ZIP input", async () => {
  const root = await mkdtemp(join(tmpdir(), "scribe-medium-invalid-"));
  fixtureRoots.add(root);
  const path = join(root, "not-an-export.zip");
  await writeFile(path, "this is not a zip");

  await expect(readMediumArchive(path)).rejects.toThrow(/valid ZIP archive/iu);
});
