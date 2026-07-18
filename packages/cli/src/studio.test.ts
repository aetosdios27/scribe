import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";

import { afterEach, expect, it, vi } from "vitest";

import { parseStudioArguments, runStudio, startStudio, type StudioHandle } from "./studio.js";

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
  expect(parseStudioArguments(["content/a.mdx"])).toEqual({
    path: "content/a.mdx",
    port: 4317,
    open: true,
    help: false
  });
  expect(parseStudioArguments(["content/a.mdx", "--wat"])).toMatchObject({ error: expect.stringContaining("--wat") });
  expect(parseStudioArguments(["content/a.txt"])).toMatchObject({ error: expect.stringContaining(".md or .mdx") });
});

it("requires an explicit Studio mode when project detection is ambiguous", async () => {
  const file = await fixture();
  await writeFile(join(file.root, "package.json"), JSON.stringify({
    dependencies: { react: "19.2.7", vite: "8.1.3", tailwindcss: "4.3.3" }
  }));
  const stderr = vi.fn();

  expect(await runStudio([file.path, "--no-open"], { cwd: file.root, stderr })).toBe(2);
  expect(stderr.mock.calls.join("\n")).toContain("Choose --mode foundation, default, or tailwind explicitly");
});

it("starts on loopback, loads the source, and reports metadata", async () => {
  const file = await fixture("peer notes.mdx", "---\ntitle: Peer notes\n---\n# Peer states\n");
  await mkdir(join(file.root, "public"), { recursive: true });
  await writeFile(join(file.root, "public", "peer-banner.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const handle = await startStudio({ root: file.root, path: file.path, mode: "foundation", port: 0, open: false });
  handles.push(handle);

  expect(new URL(handle.origin).hostname).toBe("127.0.0.1");
  const response = await fetch(`${handle.origin}/__scribe/api/document`);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    source: expect.stringContaining("Peer states"),
    sourcePath: "content/peer notes.mdx",
    mode: "foundation",
    dirty: false,
    conflict: false,
    frontmatter: { title: "Peer notes" }
  });

  const studio = await (await fetch(handle.origin)).text();
  expect(studio).toContain('id="scribe-studio"');
  expect(studio).toContain('src="/@scribe-studio/client.tsx"');
  expect(studio).not.toContain('id="mode"');

  const client = await (await fetch(`${handle.origin}/@scribe-studio/client.tsx`)).text();
  expect(client).toContain("MDXEditor");
  expect(client).toContain("lucide-react");
  expect(client).toContain("Scribe Studio");
  expect(client).toContain("Rich Text");
  expect(client).not.toContain('aria-label="Markdown formatting"');

  const styles = await (await fetch(`${handle.origin}/@scribe-studio/styles.css`)).text();
  expect(styles).toContain("#CDFF57");
  expect(styles).toContain("#0A0A0A");

  const publicImage = await fetch(`${handle.origin}/peer-banner.svg`);
  expect(publicImage.status).toBe(200);

  const existingAsset = await fetch(`${handle.origin}/__scribe/api/asset?path=${encodeURIComponent("/peer-banner.svg")}`);
  expect(existingAsset.status).toBe(200);
  await expect(existingAsset.json()).resolves.toEqual({ exists: true });

  const missingAsset = await fetch(`${handle.origin}/__scribe/api/asset?path=${encodeURIComponent("/missing.webp")}`);
  expect(missingAsset.status).toBe(200);
  await expect(missingAsset.json()).resolves.toEqual({ exists: false });
});

it("keeps the detected style mode locked while drafts change", async () => {
  const file = await fixture();
  const handle = await startStudio({ root: file.root, path: file.path, mode: "default", port: 0, open: false });
  handles.push(handle);

  const response = await fetch(`${handle.origin}/__scribe/api/draft`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "# Updated without a mode field\n" })
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ ok: true, mode: "default" });
});

it("projects protected MDX for Rich Text mode and accepts only preservation-safe edits", async () => {
  const source = `---\ntitle: Peer notes\n---\n\n# Peer states\n\nOriginal paragraph.\n\n<Callout variant="note">Keep this exact.</Callout>\n`;
  const file = await fixture("peer-notes.mdx", source);
  const handle = await startStudio({ root: file.root, path: file.path, mode: "default", port: 0, open: false });
  handles.push(handle);

  const projectedResponse = await fetch(`${handle.origin}/__scribe/api/rich-projection`);
  expect(projectedResponse.status).toBe(200);
  const projected = await projectedResponse.json() as {
    projectionMarkdown: string;
    islands: Array<{ id: string; kind: string; raw: string }>;
    revision: number;
  };
  expect(projected.projectionMarkdown).toContain("ScribeStudioProtectedIsland");
  expect(projected.islands.map(({ kind }) => kind)).toEqual(["frontmatter", "mdxJsxTextElement"]);
  expect(projected.islands.map(({ raw }) => raw)).toEqual([
    "---\ntitle: Peer notes\n---",
    '<Callout variant="note">Keep this exact.</Callout>'
  ]);

  const safe = await fetch(`${handle.origin}/__scribe/api/rich-draft`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: projected.projectionMarkdown.replace("Original paragraph.", "Edited paragraph."),
      revision: projected.revision
    })
  });
  expect(safe.status).toBe(200);
  await expect(safe.json()).resolves.toMatchObject({ ok: true, source: expect.stringContaining("Edited paragraph.") });

  const afterSafe = await (await fetch(`${handle.origin}/__scribe/api/rich-projection`)).json() as {
    projectionMarkdown: string;
    revision: number;
  };
  const unsafe = await fetch(`${handle.origin}/__scribe/api/rich-draft`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: afterSafe.projectionMarkdown.replace(/<ScribeStudioProtectedIsland[^>]+\/>/u, ""),
      revision: afterSafe.revision
    })
  });
  expect(unsafe.status).toBe(422);
  await expect(unsafe.json()).resolves.toMatchObject({
    ok: false,
    code: "SCB_RICH_PLACEHOLDER_MISSING",
    source: expect.stringContaining("Edited paragraph."),
    error: expect.stringContaining("protected block")
  });
  expect(await readFile(file.path, "utf8")).toBe(source);
});

it("invalidates a stale Rich Text projection without overwriting the current draft", async () => {
  const file = await fixture("stale.mdx", "# Original\n");
  const handle = await startStudio({ root: file.root, path: file.path, mode: "default", port: 0, open: false });
  handles.push(handle);

  const projected = await (await fetch(`${handle.origin}/__scribe/api/rich-projection`)).json() as {
    projectionMarkdown: string;
    revision: number;
  };
  await fetch(`${handle.origin}/__scribe/api/draft`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "# Markdown edit\n" })
  });

  const stale = await fetch(`${handle.origin}/__scribe/api/rich-draft`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: projected.projectionMarkdown, revision: projected.revision })
  });
  expect(stale.status).toBe(409);
  await expect(stale.json()).resolves.toMatchObject({
    ok: false,
    code: "SCB_RICH_STALE_PROJECTION",
    source: "# Markdown edit\n"
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

  const invalidRichProjection = await fetch(`${handle.origin}/__scribe/api/rich-projection`);
  expect(invalidRichProjection.status).toBe(422);
  await expect(invalidRichProjection.json()).resolves.toMatchObject({
    error: "Fix Markdown diagnostics before entering Rich Text mode."
  });

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
