import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";

import { afterEach, expect, it } from "vitest";

import { parseStudioArguments, startStudio, type StudioHandle } from "./studio.js";

const handles: StudioHandle[] = [];
afterEach(async () => Promise.all(handles.splice(0).map((handle) => handle.close())));

async function fixture(name = "article.mdx", source = "# Peer states\n"): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "scribe studio test "));
  const path = join(root, "content", name);
  await mkdir(join(root, "content"), { recursive: true });
  await writeFile(path, source);
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { react: "19.2.7", vite: "8.1.3" } }));
  return { root, path };
}

it("parses the documented studio command surface and rejects unknown flags", () => {
  expect(parseStudioArguments(["content/a.mdx", "--mode", "tailwind", "--host-css", "src/app.css", "--port", "4317", "--no-open"])).toEqual({
    path: "content/a.mdx",
    mode: "tailwind",
    hostCss: "src/app.css",
    port: 4317,
    open: false,
    help: false
  });
  expect(parseStudioArguments(["content/a.mdx", "--wat"])).toMatchObject({ error: expect.stringContaining("--wat") });
  expect(parseStudioArguments(["content/a.txt"])).toMatchObject({ error: expect.stringContaining(".md or .mdx") });
});

it("starts on loopback, loads the source, and reports metadata", async () => {
  const file = await fixture("peer notes.mdx", "---\ntitle: Peer notes\n---\n# Peer states\n");
  const handle = await startStudio({ root: file.root, path: file.path, mode: "foundation", port: 0, open: false });
  handles.push(handle);

  expect(new URL(handle.origin).hostname).toBe("127.0.0.1");
  const response = await fetch(`${handle.origin}/__scribe/api/document`);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    source: expect.stringContaining("Peer states"),
    mode: "foundation",
    dirty: false,
    conflict: false,
    frontmatter: { title: "Peer notes" }
  });
});

it("keeps invalid drafts editable, recovers the preview, and saves atomically", async () => {
  const file = await fixture();
  const handle = await startStudio({ root: file.root, path: file.path, mode: "default", port: 0, open: false });
  handles.push(handle);

  const invalid = await fetch(`${handle.origin}/__scribe/api/draft`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "<Callout>unfinished", mode: "default" })
  });
  expect(invalid.status).toBe(200);
  expect(await invalid.json()).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ line: 1 })] });
  expect(await readFile(file.path, "utf8")).toBe("# Peer states\n");

  const validSource = "# Recovered\n\n| State | Meaning |\n| --- | --- |\n| ready | valid |\n";
  const valid = await fetch(`${handle.origin}/__scribe/api/draft`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: validSource, mode: "foundation" })
  });
  expect(valid.status).toBe(200);
  const state = await valid.json() as { diskVersion: string };

  const saved = await fetch(`${handle.origin}/__scribe/api/save`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedDiskVersion: state.diskVersion })
  });
  expect(saved.status).toBe(200);
  expect(await readFile(file.path, "utf8")).toBe(validSource);
});

it("detects external changes and refuses to overwrite an unsaved draft", async () => {
  const file = await fixture();
  const handle = await startStudio({ root: file.root, path: file.path, mode: "default", port: 0, open: false });
  handles.push(handle);
  const initial = await (await fetch(`${handle.origin}/__scribe/api/document`)).json() as { diskVersion: string };

  await fetch(`${handle.origin}/__scribe/api/draft`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "# Unsaved studio draft\n", mode: "default" })
  });
  await writeFile(file.path, "# External editor change\n");

  await expect.poll(async () => {
    const state = await (await fetch(`${handle.origin}/__scribe/api/document`)).json() as { conflict: boolean };
    return state.conflict;
  }).toBe(true);

  const saved = await fetch(`${handle.origin}/__scribe/api/save`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedDiskVersion: initial.diskVersion })
  });
  expect(saved.status).toBe(409);
  expect(await readFile(file.path, "utf8")).toBe("# External editor change\n");
});

it("rejects source and host CSS paths outside the selected workspace", async () => {
  const inside = await fixture();
  const outside = await fixture("outside.mdx");

  await expect(startStudio({ root: inside.root, path: outside.path, mode: "default", port: 0, open: false })).rejects.toThrow("outside the Studio workspace");
  await expect(startStudio({ root: inside.root, path: inside.path, hostCss: outside.path, mode: "default", port: 0, open: false })).rejects.toThrow("outside the Studio workspace");
});

it("fails clearly for missing files and occupied ports", async () => {
  const file = await fixture();
  await expect(startStudio({ root: file.root, path: join(file.root, "missing.mdx"), mode: "default", port: 0, open: false })).rejects.toThrow();

  const occupied = createNetServer();
  await new Promise<void>((resolveListen) => occupied.listen(0, "127.0.0.1", resolveListen));
  const address = occupied.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a test port.");
  await expect(startStudio({ root: file.root, path: file.path, mode: "default", port: address.port, open: false })).rejects.toThrow("Could not start Scribe Studio");
  await new Promise<void>((resolveClose) => occupied.close(() => resolveClose()));
});
