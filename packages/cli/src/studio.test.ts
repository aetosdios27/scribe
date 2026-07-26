import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";

import { afterAll, afterEach, expect, it, vi } from "vitest";

import { studioRecoveryKey } from "./studio-recovery.js";
import {
  formatStudioStartup,
  parseStudioArguments,
  runStudio,
  startStudio,
  studioPreviewArticleClassName,
  type StudioHandle
} from "./studio.js";

const handles: StudioHandle[] = [];
const fixtureRoots = new Set<string>();
let operation = 0;
const studioStateRoot = join(tmpdir(), `scribe-studio-vitest-${process.pid}`);
process.env["SCRIBE_STUDIO_STATE_DIR"] = studioStateRoot;
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all([...fixtureRoots].map((root) => rm(root, { force: true, recursive: true })));
  fixtureRoots.clear();
});
afterAll(async () => rm(studioStateRoot, { force: true, recursive: true }));

async function fixture(name = "article.mdx", source = "# Peer states\n"): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "scribe studio test "));
  fixtureRoots.add(root);
  const path = join(root, "content", name);
  await mkdir(join(root, "content"), { recursive: true });
  await writeFile(path, source);
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { react: "19.2.7", vite: "8.1.3" } }));
  return { root, path };
}

async function mutate(
  handle: StudioHandle,
  path: string,
  body: Record<string, unknown> = {},
  baseRevision?: number
): Promise<Response> {
  const revision = baseRevision ?? ((await (await fetch(`${handle.origin}/__scribe/api/document`)).json()) as { revision: number }).revision;
  return fetch(`${handle.origin}${path}`, {
    method: path.endsWith("discard") ? "POST" : "PUT",
    headers: {
      "content-type": "application/json",
      "x-scribe-studio-session": handle.sessionToken,
      origin: handle.origin
    },
    body: JSON.stringify({
      ...body,
      clientId: "vitest",
      operationId: `vitest-${++operation}`,
      baseRevision: revision
    })
  });
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
  expect(parseStudioArguments(["content/a.mdx", "--no-opn"])).toEqual({ error: 'Unknown studio option "--no-opn". Did you mean "--no-open"?' });
  expect(parseStudioArguments(["content/a.txt"])).toMatchObject({ error: expect.stringContaining(".md or .mdx") });
});

it("formats Studio startup with a project-relative source path", () => {
  const root = join(tmpdir(), "scribe host");
  const source = join(root, "content", "peer notes.mdx");
  const output = formatStudioStartup(root, source, "foundation", "http://127.0.0.1:4317");

  expect(output).toMatch(/Source  content[\\/]peer notes\.mdx/u);
  expect(output).not.toContain(root);
});

it("mirrors the verified host typography boundary only in Tailwind preview mode", () => {
  expect(studioPreviewArticleClassName("tailwind")).toBe(
    "prose max-w-none text-[15px] leading-relaxed prose-p:text-[var(--text)] prose-headings:text-[var(--text)] prose-headings:font-bold prose-headings:tracking-tight prose-a:text-[var(--text)] prose-a:underline-offset-4 hover:prose-a:opacity-70 prose-strong:text-[var(--text)] prose-blockquote:border-l-[var(--text)] prose-blockquote:text-[var(--text)] prose-blockquote:opacity-80 prose-hr:border-[var(--text)]/20 prose-li:text-[var(--text)] prose-ul:text-[var(--text)] prose-img:border prose-img:border-[var(--text)]/20 prose-img:w-full [&_:not(pre)>code]:bg-[var(--text)] [&_:not(pre)>code]:text-[var(--bg)] [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:before:content-none [&_:not(pre)>code]:after:content-none"
  );
  expect(studioPreviewArticleClassName("default")).toBeUndefined();
  expect(studioPreviewArticleClassName("foundation")).toBeUndefined();
});

it("mirrors the host dark class inside the Tailwind preview document", async () => {
  const file = await fixture();
  const hostCss = join(file.root, "src", "app.css");
  await mkdir(join(file.root, "src"), { recursive: true });
  await writeFile(hostCss, '@import "@scribe-sdk/styles/tailwind.css";\n.dark { color: white; }\n');
  const handle = await startStudio({
    root: file.root,
    path: file.path,
    mode: "tailwind",
    hostCss,
    port: 0,
    open: false
  });
  handles.push(handle);

  const previewClient = await (await fetch(`${handle.origin}/@scribe-studio/preview.tsx`)).text();
  expect(previewClient).toContain('document.documentElement.classList.toggle("dark", theme === "dark")');
  expect(previewClient).toContain("data-scribe-studio-host-article");

  const previewDocument = await (await fetch(`${handle.origin}/preview`)).text();
  expect(previewDocument).toContain("[data-scribe-studio-host-article] :where(table");
  expect(previewDocument).toContain(".scribe-banner__metadata");
  expect(previewDocument).toContain(".scribe-banner__metadata{color:var(--text,#171716)!important}");
  expect(previewDocument).toContain(".scribe-code-frame__pre code *){color:#171716!important}");
  expect(previewDocument).toContain("html.dark [data-scribe-studio-host-article]");
  expect(previewDocument).toContain(".scribe-code-frame__pre code *){color:#f5f5f4!important}");

  const transformedHostCss = await (await fetch(`${handle.origin}/src/app.css`)).text();
  expect(transformedHostCss).toContain('[data-scribe-table-layout=\\"wide\\"]');
});

it("surfaces recovery read failures before opening the Studio", async () => {
  const file = await fixture();
  const recoveryRoot = await mkdtemp(join(tmpdir(), "scribe recovery failure "));
  await mkdir(join(recoveryRoot, "recovery", `${studioRecoveryKey(file.path)}.json`), { recursive: true });

  await expect(startStudio({
    root: file.root,
    path: file.path,
    mode: "default",
    port: 0,
    open: false,
    recoveryRoot
  })).rejects.toThrow("Studio could not read its local recovery state");
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
  await symlink(file.path, join(file.root, "public", "escaped.svg"));
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

  const publicImage = await fetch(`${handle.origin}/peer-banner.svg`);
  expect(publicImage.status).toBe(200);

  const existingAsset = await fetch(`${handle.origin}/__scribe/api/asset?path=${encodeURIComponent("/peer-banner.svg")}`);
  expect(existingAsset.status).toBe(200);
  await expect(existingAsset.json()).resolves.toEqual({ exists: true });

  const missingAsset = await fetch(`${handle.origin}/__scribe/api/asset?path=${encodeURIComponent("/missing.webp")}`);
  expect(missingAsset.status).toBe(200);
  await expect(missingAsset.json()).resolves.toEqual({ exists: false });
  const escapedAsset = await fetch(`${handle.origin}/__scribe/api/asset?path=${encodeURIComponent("/escaped.svg")}`);
  await expect(escapedAsset.json()).resolves.toEqual({ exists: false });
});

it("keeps the detected style mode locked while drafts change", async () => {
  const file = await fixture();
  const handle = await startStudio({ root: file.root, path: file.path, mode: "default", port: 0, open: false });
  handles.push(handle);

  const response = await mutate(handle, "/__scribe/api/draft", { source: "# Updated without a mode field\n" });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ ok: true, mode: "default" });
});

it("rejects cross-origin mutations and prevents a second tab from taking the writer lease", async () => {
  const file = await fixture();
  const handle = await startStudio({ root: file.root, path: file.path, mode: "default", port: 0, open: false });
  handles.push(handle);

  const unauthenticated = await fetch(`${handle.origin}/__scribe/api/discard`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.invalid" },
    body: "{}"
  });
  expect(unauthenticated.status).toBe(403);

  const authenticatedCrossSite = await fetch(`${handle.origin}/__scribe/api/discard`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-scribe-studio-session": handle.sessionToken,
      origin: "https://attacker.invalid",
      "sec-fetch-site": "cross-site"
    },
    body: "{}"
  });
  expect(authenticatedCrossSite.status).toBe(403);
  await expect(authenticatedCrossSite.json()).resolves.toMatchObject({
    error: expect.stringContaining("Cross-site")
  });

  const first = await mutate(handle, "/__scribe/api/draft", { source: "# First tab\n" });
  expect(first.status).toBe(200);
  const current = await (await fetch(`${handle.origin}/__scribe/api/document`)).json() as { revision: number };
  const second = await fetch(`${handle.origin}/__scribe/api/draft`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-scribe-studio-session": handle.sessionToken,
      origin: handle.origin
    },
    body: JSON.stringify({
      source: "# Second tab\n",
      clientId: "second-tab",
      operationId: "second-tab-1",
      baseRevision: current.revision
    })
  });
  expect(second.status).toBe(423);
  await expect(second.json()).resolves.toMatchObject({ code: "SCB_STUDIO_WRITER_LOCKED" });
  await expect((await fetch(`${handle.origin}/__scribe/api/document`)).json()).resolves.toMatchObject({
    source: "# First tab\n"
  });
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

  const safe = await mutate(handle, "/__scribe/api/rich-draft", {
    source: projected.projectionMarkdown.replace("Original paragraph.", "Edited paragraph.")
  }, projected.revision);
  expect(safe.status).toBe(200);
  await expect(safe.json()).resolves.toMatchObject({ ok: true, source: expect.stringContaining("Edited paragraph.") });

  const afterSafe = await (await fetch(`${handle.origin}/__scribe/api/rich-projection`)).json() as {
    projectionMarkdown: string;
    revision: number;
  };
  const unsafe = await mutate(handle, "/__scribe/api/rich-draft", {
    source: afterSafe.projectionMarkdown.replace(/<ScribeStudioProtectedIsland[^>]+\/>/u, "")
  }, afterSafe.revision);
  expect(unsafe.status).toBe(422);
  await expect(unsafe.json()).resolves.toMatchObject({
    ok: false,
    code: "SCB_RICH_PLACEHOLDER_MISSING",
    source: expect.stringContaining("Edited paragraph."),
    error: expect.stringContaining("protected frontmatter")
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
  await mutate(handle, "/__scribe/api/draft", { source: "# Markdown edit\n" });

  const stale = await mutate(handle, "/__scribe/api/rich-draft", {
    source: projected.projectionMarkdown
  }, projected.revision);
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

  const invalid = await mutate(handle, "/__scribe/api/draft", {
    source: "<Callout>unfinished",
    mode: "default"
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
  const valid = await mutate(handle, "/__scribe/api/draft", {
    source: validSource,
    mode: "foundation"
  });
  expect(valid.status).toBe(200);
  const state = await valid.json() as { diskVersion: string };

  const saved = await mutate(handle, "/__scribe/api/save", { expectedDiskVersion: state.diskVersion });
  expect(saved.status).toBe(200);
  expect(await readFile(file.path, "utf8")).toBe(validSource);
});

it("recovers an acknowledged draft after Studio restarts without touching the article", async () => {
  const file = await fixture("recovery.mdx", "# On disk\n");
  const first = await startStudio({ root: file.root, path: file.path, mode: "default", port: 0, open: false });
  const updated = await mutate(first, "/__scribe/api/draft", { source: "# Recovered draft\n" });
  expect(updated.status).toBe(200);
  await first.close();
  expect(await readFile(file.path, "utf8")).toBe("# On disk\n");

  const restarted = await startStudio({ root: file.root, path: file.path, mode: "default", port: 0, open: false });
  handles.push(restarted);
  await expect((await fetch(`${restarted.origin}/__scribe/api/document`)).json()).resolves.toMatchObject({
    source: "# Recovered draft\n",
    dirty: true,
    recovered: true,
    conflict: false
  });
});

it("keeps a discarded draft recoverable until the user explicitly resumes it", async () => {
  const file = await fixture("discard-recovery.mdx", "# On disk\n");
  const handle = await startStudio({ root: file.root, path: file.path, mode: "default", port: 0, open: false });
  handles.push(handle);
  await mutate(handle, "/__scribe/api/draft", { source: "# Unsaved\n" });

  const discarded = await mutate(handle, "/__scribe/api/discard");
  await expect(discarded.json()).resolves.toMatchObject({
    source: "# On disk\n",
    discardRecoveryAvailable: true
  });
  const recovered = await mutate(handle, "/__scribe/api/recover-discard");
  const recoveredBody = await recovered.json();
  expect({ status: recovered.status, body: recoveredBody }).toMatchObject({ status: 200 });
  expect(recoveredBody).toMatchObject({
    source: "# Unsaved\n",
    dirty: true,
    recovered: true
  });
  expect(await readFile(file.path, "utf8")).toBe("# On disk\n");
});

it("detects external changes and refuses to overwrite an unsaved draft", async () => {
  const file = await fixture();
  const handle = await startStudio({ root: file.root, path: file.path, mode: "default", port: 0, open: false });
  handles.push(handle);
  const initial = await (await fetch(`${handle.origin}/__scribe/api/document`)).json() as { diskVersion: string };

  await mutate(handle, "/__scribe/api/draft", {
    source: "# Unsaved studio draft\n",
    mode: "default"
  });
  await writeFile(file.path, "# External editor change\n");

  await expect.poll(async () => {
    const state = await (await fetch(`${handle.origin}/__scribe/api/document`)).json() as { conflict: boolean };
    return state.conflict;
  }).toBe(true);

  const saved = await mutate(handle, "/__scribe/api/save", { expectedDiskVersion: initial.diskVersion });
  expect(saved.status).toBe(409);
  expect(await readFile(file.path, "utf8")).toBe("# External editor change\n");

  const reloaded = await mutate(handle, "/__scribe/api/discard");
  expect(reloaded.status).toBe(200);
  await expect(reloaded.json()).resolves.toMatchObject({
    source: "# External editor change\n",
    dirty: false,
    conflict: false
  });
});

it("journals a browser draft against its original disk version when an external edit wins the debounce race", async () => {
  const file = await fixture("debounce-conflict.mdx", "# Original\n");
  const first = await startStudio({ root: file.root, path: file.path, mode: "default", port: 0, open: false });
  const initial = await (await fetch(`${first.origin}/__scribe/api/document`)).json() as {
    diskVersion: string;
  };

  await writeFile(file.path, "# External\n");
  await expect.poll(async () => {
    const current = await (await fetch(`${first.origin}/__scribe/api/document`)).json() as { diskVersion: string };
    return current.diskVersion;
  }).not.toBe(initial.diskVersion);

  const preserved = await mutate(first, "/__scribe/api/draft", {
    source: "# Local browser typing\n",
    externalConflict: true,
    baseDiskVersion: initial.diskVersion
  });
  await expect(preserved.json()).resolves.toMatchObject({
    source: "# Local browser typing\n",
    dirty: true,
    conflict: true,
    recoveryConflict: true
  });
  await first.close();

  const restarted = await startStudio({ root: file.root, path: file.path, mode: "default", port: 0, open: false });
  handles.push(restarted);
  await expect((await fetch(`${restarted.origin}/__scribe/api/document`)).json()).resolves.toMatchObject({
    source: "# Local browser typing\n",
    dirty: true,
    conflict: true,
    recovered: true,
    recoveryConflict: true
  });
  expect(await readFile(file.path, "utf8")).toBe("# External\n");
});

it("restores the recovery base version when a Markdown draft journal fails", async () => {
  const file = await fixture("journal-failure.mdx", "# Original\n");
  const recoveryRoot = await mkdtemp(join(tmpdir(), "scribe recovery rollback "));
  fixtureRoots.add(recoveryRoot);
  const handle = await startStudio({
    root: file.root,
    path: file.path,
    mode: "default",
    port: 0,
    open: false,
    recoveryRoot
  });
  handles.push(handle);
  const initial = await (await fetch(`${handle.origin}/__scribe/api/document`)).json() as {
    diskVersion: string;
  };
  const recoveryDirectory = join(recoveryRoot, "recovery");
  await writeFile(recoveryDirectory, "block recovery directory creation");

  const failed = await mutate(handle, "/__scribe/api/draft", {
    source: "# Failed journal\n",
    baseDiskVersion: "poisoned-version"
  });
  expect(failed.status).toBe(400);

  await unlink(recoveryDirectory);
  const retried = await mutate(handle, "/__scribe/api/draft", { source: "# Recovered journal\n" });
  expect(retried.status).toBe(200);
  const record = JSON.parse(
    await readFile(join(recoveryDirectory, `${studioRecoveryKey(file.path)}.json`), "utf8")
  ) as { baseDiskVersion: string };
  expect(record.baseDiskVersion).toBe(initial.diskVersion);
});

it("restores the recovery base version when a Rich Text draft journal fails", async () => {
  const file = await fixture("rich-journal-failure.mdx", "# Original\n\nA paragraph.\n");
  const recoveryRoot = await mkdtemp(join(tmpdir(), "scribe rich recovery rollback "));
  fixtureRoots.add(recoveryRoot);
  const handle = await startStudio({
    root: file.root,
    path: file.path,
    mode: "default",
    port: 0,
    open: false,
    recoveryRoot
  });
  handles.push(handle);
  const initial = await (await fetch(`${handle.origin}/__scribe/api/document`)).json() as {
    diskVersion: string;
  };
  const projected = await (await fetch(`${handle.origin}/__scribe/api/rich-projection`)).json() as {
    projectionMarkdown: string;
  };
  const candidate = projected.projectionMarkdown.replace("A paragraph.", "Edited paragraph.");
  const recoveryDirectory = join(recoveryRoot, "recovery");
  await writeFile(recoveryDirectory, "block recovery directory creation");

  const failed = await mutate(handle, "/__scribe/api/rich-draft", {
    source: candidate,
    baseSource: "# Original\n\nA paragraph.\n",
    baseDiskVersion: "poisoned-version"
  });
  expect(failed.status).toBe(422);

  await unlink(recoveryDirectory);
  const retried = await mutate(handle, "/__scribe/api/rich-draft", {
    source: candidate,
    baseSource: "# Original\n\nA paragraph.\n"
  });
  expect(retried.status).toBe(200);
  const record = JSON.parse(
    await readFile(join(recoveryDirectory, `${studioRecoveryKey(file.path)}.json`), "utf8")
  ) as { baseDiskVersion: string };
  expect(record.baseDiskVersion).toBe(initial.diskVersion);
});

it("preserves a pending Rich Text candidate when the source changes externally", async () => {
  const file = await fixture("rich-conflict.mdx", "# Original\n\nA paragraph.\n");
  const handle = await startStudio({ root: file.root, path: file.path, mode: "default", port: 0, open: false });
  handles.push(handle);
  const initial = await (await fetch(`${handle.origin}/__scribe/api/document`)).json() as {
    diskVersion: string;
  };
  const projected = await (await fetch(`${handle.origin}/__scribe/api/rich-projection`)).json() as {
    projectionMarkdown: string;
  };

  await writeFile(file.path, "# External\n\nChanged in the IDE.\n");
  await expect.poll(async () => {
    const current = await (await fetch(`${handle.origin}/__scribe/api/document`)).json() as { diskVersion: string };
    return current.diskVersion;
  }).not.toBe(initial.diskVersion);

  const preserved = await mutate(handle, "/__scribe/api/rich-draft", {
    source: projected.projectionMarkdown.replace("A paragraph.", "Typing from Rich Text."),
    baseSource: "# Original\n\nA paragraph.\n",
    baseDiskVersion: initial.diskVersion
  });

  expect(preserved.status).toBe(200);
  await expect(preserved.json()).resolves.toMatchObject({
    source: expect.stringContaining("Typing from Rich Text."),
    dirty: true,
    conflict: true,
    recoveryConflict: true
  });
  expect(await readFile(file.path, "utf8")).toBe("# External\n\nChanged in the IDE.\n");
});

it("revalidates the source on disk immediately before saving", async () => {
  const file = await fixture();
  const handle = await startStudio({ root: file.root, path: file.path, mode: "default", port: 0, open: false });
  handles.push(handle);
  const initial = await (await fetch(`${handle.origin}/__scribe/api/document`)).json() as { diskVersion: string };

  await mutate(handle, "/__scribe/api/draft", { source: "# Unsaved studio draft\n" });
  await writeFile(file.path, "# External editor change before watcher delivery\n");

  const saved = await mutate(handle, "/__scribe/api/save", { expectedDiskVersion: initial.diskVersion });

  expect(saved.status).toBe(409);
  await expect(saved.json()).resolves.toMatchObject({
    conflict: true,
    error: expect.stringContaining("changed outside Studio")
  });
  expect(await readFile(file.path, "utf8")).toBe("# External editor change before watcher delivery\n");
});

it("refuses to save through a source symlink whose target changed after startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "scribe studio symlink swap "));
  const firstTarget = join(root, "first.mdx");
  const secondTarget = join(root, "second.mdx");
  const sourceLink = join(root, "article.mdx");
  await writeFile(firstTarget, "# Same bytes\n");
  await writeFile(secondTarget, "# Same bytes\n");
  await symlink(firstTarget, sourceLink);
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { react: "19.2.7", vite: "8.1.3" } }));
  const handle = await startStudio({ root, path: sourceLink, mode: "default", port: 0, open: false });
  handles.push(handle);
  const initial = await (await fetch(`${handle.origin}/__scribe/api/document`)).json() as { diskVersion: string };

  await mutate(handle, "/__scribe/api/draft", { source: "# Unsaved Studio draft\n" });
  await unlink(sourceLink);
  await symlink(secondTarget, sourceLink);
  const saved = await mutate(handle, "/__scribe/api/save", { expectedDiskVersion: initial.diskVersion });

  expect(saved.status).toBe(409);
  await expect(saved.json()).resolves.toMatchObject({
    conflict: true,
    source: "# Unsaved Studio draft\n",
    error: expect.stringContaining("target changed")
  });
  expect(await readFile(secondTarget, "utf8")).toBe("# Same bytes\n");
});

it("keeps the draft conflicted when reload cannot read a deleted source", async () => {
  const file = await fixture();
  const handle = await startStudio({ root: file.root, path: file.path, mode: "default", port: 0, open: false });
  handles.push(handle);

  await mutate(handle, "/__scribe/api/draft", { source: "# Unsaved studio draft\n" });
  await unlink(file.path);
  await expect.poll(async () => {
    const state = await (await fetch(`${handle.origin}/__scribe/api/document`)).json() as { conflict: boolean };
    return state.conflict;
  }).toBe(true);

  const reloaded = await mutate(handle, "/__scribe/api/discard");

  expect(reloaded.status).toBe(409);
  await expect(reloaded.json()).resolves.toMatchObject({
    conflict: true,
    dirty: true,
    source: "# Unsaved studio draft\n",
    error: expect.stringContaining("deleted or renamed")
  });
});

it("preserves CRLF line endings when a draft is saved", async () => {
  const file = await fixture("crlf.mdx", "# Peer states\r\n\r\nOriginal.\r\n");
  const handle = await startStudio({ root: file.root, path: file.path, mode: "default", port: 0, open: false });
  handles.push(handle);
  const initial = await (await fetch(`${handle.origin}/__scribe/api/document`)).json() as { diskVersion: string };

  await mutate(handle, "/__scribe/api/draft", { source: "# Peer states\n\nUpdated.\n" });
  const saved = await mutate(handle, "/__scribe/api/save", { expectedDiskVersion: initial.diskVersion });

  expect(saved.status).toBe(200);
  expect(await readFile(file.path, "utf8")).toBe("# Peer states\r\n\r\nUpdated.\r\n");
});

it("rejects source and host CSS paths outside the selected workspace", async () => {
  const inside = await fixture();
  const outside = await fixture("outside.mdx");
  const linkedSource = join(inside.root, "content", "linked.mdx");
  const linkedCss = join(inside.root, "linked.css");
  await symlink(outside.path, linkedSource);
  await symlink(outside.path, linkedCss);

  await expect(startStudio({ root: inside.root, path: outside.path, mode: "default", port: 0, open: false })).rejects.toThrow("outside the Studio workspace");
  await expect(startStudio({ root: inside.root, path: inside.path, hostCss: outside.path, mode: "default", port: 0, open: false })).rejects.toThrow("outside the Studio workspace");
  await expect(startStudio({ root: inside.root, path: linkedSource, mode: "default", port: 0, open: false })).rejects.toThrow("Resolved source file is outside");
  await expect(startStudio({ root: inside.root, path: inside.path, hostCss: linkedCss, mode: "default", port: 0, open: false })).rejects.toThrow("Resolved host CSS is outside");
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
