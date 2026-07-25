import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { StudioRecoveryStore, studioRecoveryKey } from "./studio-recovery.js";

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

it("propagates recovery read failures instead of quarantining inaccessible records", async () => {
  const root = await mkdtemp(join(tmpdir(), "scribe recovery "));
  const sourcePath = "/project/article.mdx";
  const activePath = join(root, "recovery", `${studioRecoveryKey(sourcePath)}.json`);
  await mkdir(activePath, { recursive: true });

  await expect(new StudioRecoveryStore(sourcePath, root).loadDraft()).rejects.toBeDefined();
  expect((await readdir(join(root, "recovery")))).toContain(`${studioRecoveryKey(sourcePath)}.json`);
});

it("trims only recognized completed archives and preserves in-flight temporary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "scribe recovery "));
  const sourcePath = "/project/article.mdx";
  const key = studioRecoveryKey(sourcePath);
  const directory = join(root, "recovery");
  await mkdir(directory, { recursive: true });
  for (let index = 0; index < 22; index += 1) {
    await writeFile(join(directory, `${key}.${String(1_000 + index)}.deadbeef.checkpoint.json`), "{}");
  }
  const temporary = `${key}.0000.deadbeef.checkpoint.json.writer.tmp`;
  const unrelated = `${key}.0000.unrelated.json`;
  await writeFile(join(directory, temporary), "in flight");
  await writeFile(join(directory, unrelated), "unrelated");

  const store = new StudioRecoveryStore(sourcePath, root);
  await store.writeHistory({
    sourcePath,
    baseDiskVersion: "disk-a",
    draftSource: "# History\n",
    revision: 4
  }, "checkpoint");

  const entries = await readdir(directory);
  expect(entries).toContain(temporary);
  expect(entries).toContain(unrelated);
  expect(entries.filter((entry) => /\.(?:discarded|saved|reverted|checkpoint)\.json$/u.test(entry))).toHaveLength(20);
});
