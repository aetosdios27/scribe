import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

import mdx from "@mdx-js/rollup";
import { compileScribeMdx, createScribeMdxOptions } from "@scribe-sdk/mdx";
import react from "@vitejs/plugin-react";
import { createServer, normalizePath, type Plugin, type ViteDevServer } from "vite";

import type { StyleMode } from "./init.js";

const studioRequire = createRequire(import.meta.url);

export interface StudioOptions {
  readonly root: string;
  readonly path: string;
  readonly mode: StyleMode;
  readonly hostCss?: string;
  readonly port: number;
  readonly open: boolean;
}

export interface StudioHandle {
  readonly origin: string;
  readonly close: () => Promise<void>;
}

export interface StudioArguments {
  readonly path: string;
  readonly mode: StyleMode;
  readonly hostCss?: string;
  readonly port: number;
  readonly open: boolean;
  readonly help: boolean;
}

interface StudioArgumentError {
  readonly error: string;
}

interface StudioState {
  diskSource: string;
  draftSource: string;
  previewSource: string;
  diskVersion: string;
  previewVersion: number;
  mode: StyleMode;
  lineEnding: "\n" | "\r\n";
  dirty: boolean;
  conflict: boolean;
  diagnostics: StudioDiagnostic[];
}

interface StudioDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

const styleModes = new Set<StyleMode>(["foundation", "default", "tailwind"]);
const articleExtensions = new Set([".md", ".mdx"]);
const maxRequestBytes = 5 * 1024 * 1024;

export const studioHelp = `Open Scribe's local, source-authoritative MDX Studio.

Usage:
  scb studio <article.mdx> [options]

Options:
  --mode <mode>     Preview with foundation, default, or tailwind CSS.
  --host-css <path> Load one explicit local host stylesheet.
  --port <number>   Use a specific loopback port (default: 4317).
  --no-open         Do not open the system browser automatically.
  -h, --help        Show this command help.
`;

export function parseStudioArguments(args: readonly string[]): StudioArguments | StudioArgumentError {
  let path: string | undefined;
  let mode: StyleMode = "default";
  let hostCss: string | undefined;
  let port = 4317;
  let open = true;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--no-open") open = false;
    else if (argument === "--mode") {
      const value = args[index + 1];
      if (!styleModes.has(value as StyleMode)) return { error: `Invalid --mode value "${String(value)}". Expected one of: foundation, default, tailwind.` };
      mode = value as StyleMode;
      index += 1;
    } else if (argument === "--host-css") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return { error: "--host-css requires a local CSS path." };
      hostCss = value;
      index += 1;
    } else if (argument === "--port") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 65_535) return { error: "--port requires an integer from 1 to 65535." };
      port = value;
      index += 1;
    } else if (argument?.startsWith("-")) return { error: `Unknown studio option "${argument}".` };
    else if (path === undefined) path = argument;
    else return { error: "Expected exactly one Markdown or MDX source file." };
  }

  if (help) return { path: path ?? "", mode, port, open, help, ...(hostCss === undefined ? {} : { hostCss }) };
  if (path === undefined) return { error: "Expected one Markdown or MDX source file." };
  if (!articleExtensions.has(extname(path).toLowerCase())) return { error: "Studio source must use a .md or .mdx extension." };
  return { path, mode, port, open, help, ...(hostCss === undefined ? {} : { hostCss }) };
}

export async function startStudio(options: StudioOptions): Promise<StudioHandle> {
  const root = resolve(options.root);
  const sourcePath = resolve(root, options.path);
  assertWithinWorkspace(root, sourcePath, "Source file");
  if (!articleExtensions.has(extname(sourcePath).toLowerCase())) throw new Error("Studio source must use a .md or .mdx extension.");
  await access(sourcePath, constants.R_OK | constants.W_OK);

  const hostCss = options.hostCss === undefined ? undefined : resolve(root, options.hostCss);
  if (hostCss !== undefined) {
    assertWithinWorkspace(root, hostCss, "Host CSS");
    if (extname(hostCss).toLowerCase() !== ".css") throw new Error("--host-css must reference a .css file.");
    await access(hostCss, constants.R_OK);
  }

  const diskSource = await readUtf8(sourcePath);
  const state: StudioState = {
    diskSource,
    draftSource: diskSource,
    previewSource: diskSource,
    diskVersion: fingerprint(diskSource),
    previewVersion: 1,
    mode: options.mode,
    lineEnding: diskSource.includes("\r\n") ? "\r\n" : "\n",
    dirty: false,
    conflict: false,
    diagnostics: await diagnosticsFor(sourcePath, diskSource)
  };

  const articleId = `${sourcePath}.scribe-studio.mdx`;
  const runtime = studioRuntimePaths();
  let server: ViteDevServer;
  const studioPlugin = createStudioPlugin({ root, sourcePath, articleId, state, runtime, ...(hostCss === undefined ? {} : { hostCss }) });
  server = await createServer({
    configFile: false,
    root,
    appType: "custom",
    server: {
      host: "127.0.0.1",
      port: options.port,
      strictPort: options.port !== 0,
      open: false,
      fs: { strict: true, allow: [root, ...Object.values(runtime).map(dirname)] }
    },
    plugins: [studioPlugin, { ...mdx(createScribeMdxOptions()), enforce: "pre" }, react()]
  });

  try {
    await server.listen();
  } catch (error) {
    await server.close();
    throw new Error(`Could not start Scribe Studio on 127.0.0.1:${options.port}: ${error instanceof Error ? error.message : String(error)}`);
  }

  server.watcher.add(sourcePath);
  server.watcher.on("change", async (path) => {
    if (resolve(path) !== sourcePath) return;
    const source = await readUtf8(sourcePath);
    if (source === state.diskSource) return;
    const wasClean = !state.dirty;
    state.diskSource = source;
    state.diskVersion = fingerprint(source);
    state.lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
    if (wasClean) {
      state.draftSource = source;
      state.previewSource = source;
      state.diagnostics = await diagnosticsFor(sourcePath, source);
      state.previewVersion += 1;
      invalidateArticle(server, articleId);
    } else {
      state.conflict = true;
    }
  });
  server.watcher.on("unlink", (path) => {
    if (resolve(path) !== sourcePath) return;
    state.conflict = true;
    state.diagnostics = [{
      severity: "error",
      code: "SCB2001",
      message: "The source file was deleted or renamed outside Studio. Save is blocked until it is restored or the session is closed."
    }];
  });

  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    await server.close();
    throw new Error("Scribe Studio did not expose a local HTTP address.");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  if (options.open) openBrowser(origin);
  return { origin, close: async () => server.close() };
}

export async function runStudio(
  args: readonly string[],
  dependencies: {
    readonly cwd?: string;
    readonly stdout?: (value: string) => void;
    readonly stderr?: (value: string) => void;
  } = {}
): Promise<number> {
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = dependencies.stderr ?? ((value: string) => process.stderr.write(value));
  const parsed = parseStudioArguments(args);
  if ("error" in parsed) {
    stderr(`${parsed.error}\n${studioHelp}`);
    return 2;
  }
  if (parsed.help) {
    stdout(studioHelp);
    return 0;
  }

  let handle: StudioHandle;
  try {
    handle = await startStudio({
      root: dependencies.cwd ?? process.cwd(),
      path: parsed.path,
      mode: parsed.mode,
      port: parsed.port,
      open: parsed.open,
      ...(parsed.hostCss === undefined ? {} : { hostCss: parsed.hostCss })
    });
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  stdout(`Scribe Studio: ${handle.origin}\nSource remains authoritative; save explicitly from the Studio or your editor.\n`);
  await new Promise<void>((resolveStop) => {
    const stop = () => resolveStop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await handle.close();
  return 0;
}

function createStudioPlugin(context: {
  readonly root: string;
  readonly sourcePath: string;
  readonly hostCss?: string;
  readonly articleId: string;
  readonly runtime: StudioRuntimePaths;
  readonly state: StudioState;
}): Plugin {
  const previewId = "\0scribe-studio-preview.tsx";
  return {
    name: "scribe-studio",
    enforce: "pre",
    resolveId(id) {
      if (id === "/@scribe-studio/preview.tsx") return previewId;
      if (id === "virtual:scribe-studio-article") return context.articleId;
      return undefined;
    },
    load(id) {
      if (id === context.articleId) return context.state.previewSource;
      if (id === previewId) return previewModule(context.state.mode, context.runtime, context.hostCss);
      return undefined;
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/__scribe/api/document" && request.method === "GET") {
          return json(response, 200, publicState(context.state));
        }
        if (url.pathname === "/__scribe/api/draft" && request.method === "PUT") {
          try {
            const body = await readJsonBody(request) as { source?: unknown; mode?: unknown };
            if (typeof body.source !== "string" || !styleModes.has(body.mode as StyleMode)) {
              return json(response, 400, { error: "Draft requires string source and a valid style mode." });
            }
            context.state.draftSource = normalizeLineEndings(body.source, context.state.lineEnding);
            context.state.mode = body.mode as StyleMode;
            context.state.dirty = context.state.draftSource !== context.state.diskSource;
            context.state.diagnostics = await diagnosticsFor(context.sourcePath, context.state.draftSource);
            const hasErrors = context.state.diagnostics.some(({ severity }) => severity === "error");
            if (!hasErrors) {
              context.state.previewSource = context.state.draftSource;
              context.state.previewVersion += 1;
              invalidateArticle(server, context.articleId);
              const preview = server.moduleGraph.getModuleById(previewId);
              if (preview) server.moduleGraph.invalidateModule(preview);
            }
            return json(response, 200, { ok: !hasErrors, ...publicState(context.state) });
          } catch (error) {
            return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (url.pathname === "/__scribe/api/save" && request.method === "PUT") {
          try {
            const body = await readJsonBody(request) as { expectedDiskVersion?: unknown };
            if (body.expectedDiskVersion !== context.state.diskVersion || context.state.conflict) {
              return json(response, 409, { error: "The source changed outside Studio. Reload or reconcile before saving.", ...publicState(context.state) });
            }
            await atomicWrite(context.sourcePath, context.state.draftSource);
            context.state.diskSource = context.state.draftSource;
            context.state.diskVersion = fingerprint(context.state.diskSource);
            context.state.dirty = false;
            context.state.conflict = false;
            return json(response, 200, { ok: true, ...publicState(context.state) });
          } catch (error) {
            return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (url.pathname === "/__scribe/api/discard" && request.method === "POST") {
          context.state.draftSource = context.state.diskSource;
          context.state.previewSource = context.state.diskSource;
          context.state.dirty = false;
          context.state.conflict = false;
          context.state.diagnostics = await diagnosticsFor(context.sourcePath, context.state.diskSource);
          context.state.previewVersion += 1;
          invalidateArticle(server, context.articleId);
          return json(response, 200, { ok: true, ...publicState(context.state) });
        }
        if (url.pathname === "/" || url.pathname === "/studio") {
          response.statusCode = 200;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(await server.transformIndexHtml(url.pathname, studioHtml()));
          return;
        }
        if (url.pathname === "/preview") {
          response.statusCode = 200;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(await server.transformIndexHtml(url.pathname, previewHtml()));
          return;
        }
        next();
      });
    }
  };
}

interface StudioRuntimePaths {
  readonly scribeReact: string;
  readonly foundation: string;
  readonly default: string;
  readonly tailwind: string;
}

function studioRuntimePaths(): StudioRuntimePaths {
  return {
    scribeReact: studioRequire.resolve("@scribe-sdk/react"),
    foundation: studioRequire.resolve("@scribe-sdk/styles/foundation.css"),
    default: studioRequire.resolve("@scribe-sdk/styles/default.css"),
    tailwind: studioRequire.resolve("@scribe-sdk/styles/tailwind.css")
  };
}

function previewModule(mode: StyleMode, runtime: StudioRuntimePaths, hostCss?: string): string {
  const hostImport = hostCss === undefined ? "" : `import ${JSON.stringify(`/@fs/${normalizePath(hostCss)}`)};`;
  const moduleImport = (path: string) => JSON.stringify(`/@fs/${normalizePath(path)}`);
  return `import * as React from "react";
import { createRoot } from "react-dom/client";
import { Publication, createScribeComponents } from ${moduleImport(runtime.scribeReact)};
import ${moduleImport(runtime[mode])};
${hostImport}
import Article from "virtual:scribe-studio-article";
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
function Wrapper(props) { return React.createElement(Publication, { ...props, "data-theme": theme }); }
const components = createScribeComponents({ components: { wrapper: Wrapper } });
createRoot(document.querySelector("#preview")).render(React.createElement(Article, { components }));
`;
}

function studioHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scribe Studio</title><style>${studioCss()}</style></head><body>
<main class="studio-shell">
  <header class="studio-toolbar">
    <div class="studio-brand"><span class="studio-mark" aria-hidden="true">S</span><div><strong>Scribe Studio</strong><span>Public alpha · local source workspace</span></div></div>
    <div class="studio-status" data-status="loading"><span class="studio-status__dot"></span><span id="status-text">Loading source…</span></div>
    <div class="studio-actions"><button id="copy-diagnostics" type="button">Copy diagnostics</button><button id="save" class="studio-save" type="button">Save <kbd>⌘S</kbd></button></div>
  </header>
  <section class="studio-controls" aria-label="Preview controls">
    <label>Style <select id="mode"><option value="foundation">Foundation</option><option value="default">Default</option><option value="tailwind">Tailwind</option></select></label>
    <div class="segmented" role="group" aria-label="Viewport"><button data-width="100%" aria-pressed="true">Desktop</button><button data-width="768px">Tablet</button><button data-width="390px">Mobile</button></div>
    <div class="segmented" role="group" aria-label="Appearance"><button data-theme="light" aria-pressed="true">Light</button><button data-theme="dark">Dark</button></div>
    <span id="document-meta" class="document-meta"></span>
  </section>
  <section class="studio-workspace">
    <div class="source-panel"><div class="panel-label"><span>Source</span><span id="dirty-label">Saved</span></div><textarea id="source" spellcheck="false" aria-label="Article source"></textarea><pre id="diagnostics" class="diagnostics" aria-live="polite"></pre></div>
    <div class="preview-panel"><div class="panel-label"><span>Preview</span><span id="preview-label">Production renderer</span></div><div class="preview-stage"><iframe id="preview" title="Scribe article preview" src="/preview?theme=light"></iframe></div></div>
  </section>
  <div id="conflict" class="conflict" hidden><strong>Source changed outside Studio.</strong><span>Your unsaved draft is preserved.</span><button id="discard" type="button">Reload from disk</button></div>
</main><script type="module">${studioClient()}</script></body></html>`;
}

function previewHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:light dark}body{margin:0;padding:clamp(1rem,4vw,3rem);background:#fff;color:#171716}body:has(.scribe[data-theme=dark]){background:#101112;color:#eeece8}</style></head><body><div id="preview"></div><script type="module" src="/@scribe-studio/preview.tsx"></script></body></html>`;
}

function studioClient(): string {
  return `const source = document.querySelector('#source');
const mode = document.querySelector('#mode');
const frame = document.querySelector('#preview');
const status = document.querySelector('.studio-status');
const statusText = document.querySelector('#status-text');
const diagnostics = document.querySelector('#diagnostics');
const dirtyLabel = document.querySelector('#dirty-label');
const conflict = document.querySelector('#conflict');
const meta = document.querySelector('#document-meta');
let diskVersion = '';
let previewVersion = 0;
let timer;
async function request(path, options) { const response = await fetch(path, options); const body = await response.json(); return { response, body }; }
function apply(state, replaceSource = false) {
  diskVersion = state.diskVersion;
  mode.value = state.mode;
  if (replaceSource) source.value = state.source;
  dirtyLabel.textContent = state.conflict ? 'Conflict' : state.dirty ? 'Unsaved' : 'Saved';
  conflict.hidden = !state.conflict;
  diagnostics.textContent = state.diagnostics.map((item) => (item.line ? item.line + ':' + (item.column || 1) + ' ' : '') + '[' + item.severity + ' ' + item.code + '] ' + item.message).join('\\n');
  const lines = source.value.split('\\n').length; const words = source.value.trim() ? source.value.trim().split(/\\s+/).length : 0;
  meta.textContent = lines + ' lines · ' + words + ' words';
  const hasError = state.diagnostics.some((item) => item.severity === 'error');
  status.dataset.status = state.conflict ? 'conflict' : hasError ? 'error' : state.dirty ? 'dirty' : 'ready';
  statusText.textContent = state.conflict ? 'External change' : hasError ? 'Compilation blocked' : state.dirty ? 'Unsaved draft' : 'Ready';
  if (state.previewVersion !== previewVersion) { previewVersion = state.previewVersion; frame.contentWindow?.location.reload(); }
}
async function updateDraft() {
  const { body } = await request('/__scribe/api/draft', { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify({ source: source.value, mode: mode.value }) });
  apply(body);
}
source.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(updateDraft, 320); dirtyLabel.textContent = 'Unsaved'; });
mode.addEventListener('change', updateDraft);
document.querySelector('#save').addEventListener('click', async () => { await updateDraft(); const { response, body } = await request('/__scribe/api/save', { method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({expectedDiskVersion:diskVersion}) }); apply(body); if (!response.ok) conflict.hidden = false; });
document.querySelector('#discard').addEventListener('click', async () => { const { body } = await request('/__scribe/api/discard', {method:'POST'}); apply(body, true); });
document.querySelector('#copy-diagnostics').addEventListener('click', async () => { try { await navigator.clipboard.writeText(diagnostics.textContent || 'No Scribe diagnostics.'); } catch {} });
document.querySelectorAll('[data-width]').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('[data-width]').forEach((item) => item.setAttribute('aria-pressed', String(item === button))); frame.style.width = button.dataset.width; }));
document.querySelectorAll('[data-theme]').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('[data-theme]').forEach((item) => item.setAttribute('aria-pressed', String(item === button))); frame.src = '/preview?theme=' + button.dataset.theme; }));
addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); document.querySelector('#save').click(); } });
const initial = await request('/__scribe/api/document'); apply(initial.body, true);
setInterval(async () => { const current = await request('/__scribe/api/document'); if (current.body.diskVersion !== diskVersion || current.body.conflict) apply(current.body, !current.body.dirty); }, 900);
`;
}

function studioCss(): string {
  return `:root{color-scheme:dark;--ink:#e9e8e3;--muted:#91918c;--line:#30312f;--panel:#161716;--raised:#20211f;--accent:#d8ff63}*{box-sizing:border-box}html,body,#root{min-height:100%}body{margin:0;background:#0d0e0d;color:var(--ink);font:13px/1.45 Inter,ui-sans-serif,system-ui,sans-serif}.studio-shell{min-height:100vh;display:grid;grid-template-rows:auto auto 1fr}.studio-toolbar{min-height:66px;display:flex;align-items:center;gap:24px;padding:10px 18px;border-bottom:1px solid var(--line);background:#111210}.studio-brand{display:flex;align-items:center;gap:11px;min-width:230px}.studio-brand strong,.studio-brand span{display:block}.studio-brand>div>span{color:var(--muted);font-size:11px}.studio-mark{display:grid;place-items:center;width:34px;height:34px;background:var(--accent);color:#111;font:800 17px/1 ui-monospace,monospace}.studio-status{display:flex;align-items:center;gap:8px;margin-inline:auto;color:var(--muted)}.studio-status__dot{width:7px;height:7px;border-radius:50%;background:#777}.studio-status[data-status=ready] .studio-status__dot{background:#8fd694}.studio-status[data-status=error] .studio-status__dot,.studio-status[data-status=conflict] .studio-status__dot{background:#ff7b67}.studio-status[data-status=dirty] .studio-status__dot{background:#f3c969}.studio-actions{display:flex;gap:8px}.studio-actions button,.studio-controls button,.studio-controls select,.conflict button{min-height:34px;border:1px solid var(--line);border-radius:5px;background:var(--raised);color:inherit;font:inherit;padding:0 12px}.studio-save{background:var(--accent)!important;color:#111!important;border-color:var(--accent)!important;font-weight:700!important}kbd{margin-left:8px;font:10px ui-monospace,monospace;opacity:.65}.studio-controls{display:flex;align-items:center;gap:18px;padding:9px 18px;border-bottom:1px solid var(--line);background:#131412}.studio-controls label{display:flex;align-items:center;gap:8px;color:var(--muted)}.segmented{display:flex}.segmented button{border-radius:0;margin-left:-1px}.segmented button:first-child{border-radius:5px 0 0 5px}.segmented button:last-child{border-radius:0 5px 5px 0}.segmented button[aria-pressed=true]{color:#111;background:#d8ff63;border-color:#d8ff63}.document-meta{margin-left:auto;color:var(--muted);font:11px ui-monospace,monospace}.studio-workspace{min-height:0;display:grid;grid-template-columns:minmax(320px,.82fr) minmax(420px,1.18fr);height:calc(100vh - 116px)}.source-panel,.preview-panel{min-width:0;min-height:0;display:grid;grid-template-rows:36px 1fr}.source-panel{border-right:1px solid var(--line)}.panel-label{display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-bottom:1px solid var(--line);color:var(--muted);font:11px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em}#source{width:100%;height:100%;resize:none;border:0;outline:0;padding:22px;background:var(--panel);color:#dddcd6;font:14px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:2}.source-panel:has(#source:focus){box-shadow:inset 2px 0 var(--accent)}.diagnostics{position:absolute;left:14px;bottom:12px;right:calc(50% + 14px);max-height:25vh;overflow:auto;margin:0;padding:10px 12px;border:1px solid #49312d;background:#1e1513eF;color:#ffad9d;font:11px/1.5 ui-monospace,monospace;white-space:pre-wrap}.diagnostics:empty{display:none}.preview-stage{display:grid;place-items:start center;overflow:auto;padding:22px;background:#222320;background-image:linear-gradient(45deg,#252624 25%,transparent 25%),linear-gradient(-45deg,#252624 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#252624 75%),linear-gradient(-45deg,transparent 75%,#252624 75%);background-size:18px 18px;background-position:0 0,0 9px,9px -9px,-9px 0}#preview{display:block;width:100%;min-height:calc(100vh - 190px);border:0;background:white;box-shadow:0 18px 60px #0008;transition:width .2s ease}.conflict{position:fixed;right:18px;bottom:18px;display:grid;gap:4px;max-width:360px;padding:16px;border:1px solid #735043;background:#271b17;box-shadow:0 16px 50px #0008}.conflict[hidden]{display:none}.conflict span{color:#c7a99e}.conflict button{margin-top:8px}@media(max-width:800px){.studio-toolbar{flex-wrap:wrap}.studio-status{order:3;width:100%}.studio-controls{overflow:auto}.studio-workspace{grid-template-columns:1fr;height:auto}.source-panel{height:58vh;border-right:0;border-bottom:1px solid var(--line)}.preview-panel{height:70vh}.diagnostics{right:14px}.document-meta{display:none}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}`;
}

function publicState(state: StudioState) {
  return {
    source: state.draftSource,
    diskVersion: state.diskVersion,
    previewVersion: state.previewVersion,
    mode: state.mode,
    dirty: state.dirty,
    conflict: state.conflict,
    diagnostics: state.diagnostics,
    frontmatter: frontmatter(state.draftSource)
  };
}

async function diagnosticsFor(path: string, source: string): Promise<StudioDiagnostic[]> {
  try {
    const file = await compileScribeMdx({ path, value: source });
    return file.messages.map((message) => ({
      severity: "warning" as const,
      code: message.ruleId ?? "SCB0001",
      message: message.reason,
      ...(message.line === undefined ? {} : { line: message.line }),
      ...(message.column === undefined ? {} : { column: message.column })
    }));
  } catch (error) {
    const diagnostic = error as { reason?: string; message?: string; ruleId?: string; line?: number; column?: number };
    return [{
      severity: "error",
      code: diagnostic.ruleId ?? "SCB0001",
      message: diagnostic.reason ?? diagnostic.message ?? String(error),
      ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
      ...(diagnostic.column === undefined ? {} : { column: diagnostic.column })
    }];
  }
}

function frontmatter(source: string): Record<string, string> {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
  if (!match) return {};
  return Object.fromEntries(match[1]!.split(/\r?\n/u).flatMap((line) => {
    const pair = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/u.exec(line);
    return pair ? [[pair[1]!, pair[2]!.replace(/^(?:"(.*)"|'(.*)')$/u, "$1$2")]] : [];
  }));
}

function normalizeLineEndings(source: string, ending: "\n" | "\r\n"): string {
  return source.replace(/\r\n?|\n/gu, "\n").replaceAll("\n", ending);
}

async function readUtf8(path: string): Promise<string> {
  const bytes = await readFile(path);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Studio could not decode ${path} as UTF-8.`);
  }
}

function fingerprint(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function assertWithinWorkspace(root: string, path: string, label: string): void {
  const value = relative(root, path);
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error(`${label} is outside the Studio workspace ${root}.`);
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const info = await stat(path);
  const temporary = `${path}.scribe-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, content, { encoding: "utf8", mode: info.mode });
  await rename(temporary, path);
}

function invalidateArticle(server: ViteDevServer, articleId: string): void {
  const module = server.moduleGraph.getModuleById(articleId);
  if (module) server.moduleGraph.invalidateModule(module);
}

async function readJsonBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxRequestBytes) throw new Error("Studio request exceeds 5 MiB.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(value));
}

function openBrowser(url: string): void {
  const command: [string, ...string[]] = process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url];
  const [executable, ...args] = command;
  const child = spawn(executable, args, { detached: true, stdio: "ignore", shell: false });
  child.unref();
}
