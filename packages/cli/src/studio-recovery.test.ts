import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { StudioRecoveryStore } from "./studio-recovery.js";

it("durably restores the latest accepted unsaved draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "scribe recovery "));
  const store = new StudioRecoveryStore("/project/content/article.mdx", root);
  await store.writeDraft({
    sourcePath: "/project/content/article.mdx",
    baseDiskVersion: "disk-a",
    draftSource: "# Unsaved\n",
    revision: 7
  });

  await expect(new StudioRecoveryStore("/project/content/article.mdx", root).loadDraft()).resolves.toMatchObject({
    baseDiskVersion: "disk-a",
    draftSource: "# Unsaved\n",
    revision: 7
  });
  expect((await readdir(join(root, "recovery"))).every((name) => !name.includes("article.mdx"))).toBe(true);
});

it("archives discarded drafts so they remain recoverable", async () => {
  const root = await mkdtemp(join(tmpdir(), "scribe recovery "));
  const store = new StudioRecoveryStore("/project/article.mdx", root);
  await store.writeDraft({
    sourcePath: "/project/article.mdx",
    baseDiskVersion: "disk-a",
    draftSource: "# Discard me\n",
    revision: 3
  });

  await store.archiveDraft("discarded");
  await expect(store.loadDraft()).resolves.toBeUndefined();
  await expect(store.loadLatestArchive("discarded")).resolves.toMatchObject({ draftSource: "# Discard me\n" });
});

it("quarantines a corrupted active record instead of trusting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "scribe recovery "));
  const store = new StudioRecoveryStore("/project/article.mdx", root);
  await store.writeDraft({
    sourcePath: "/project/article.mdx",
    baseDiskVersion: "disk-a",
    draftSource: "# Safe\n",
    revision: 1
  });
  const directory = join(root, "recovery");
  const active = (await readdir(directory)).find((name) => name.endsWith(".json"));
  if (active === undefined) throw new Error("Recovery fixture was not written.");
  const value = JSON.parse(await readFile(join(directory, active), "utf8")) as { draftSource: string };
  value.draftSource = "# Tampered\n";
  await writeFile(join(directory, active), JSON.stringify(value));

  await expect(store.loadDraft()).resolves.toBeUndefined();
  expect((await readdir(directory)).some((name) => name.endsWith(".corrupt"))).toBe(true);
});
