import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import mdx from "@mdx-js/rollup";
import { compileScribeMdx, createScribeMdxOptions } from "@scribe-sdk/mdx";
import react from "@vitejs/plugin-react";
import { createServer as createViteServer, normalizePath, type Plugin, type ViteDevServer } from "vite";

import { resolveProjectStyleMode, type StyleMode } from "./init.js";
import { acceptRichCandidate, createRichProjection, type RichProjection } from "./rich-preservation.js";
import { studioClientModule, studioStyles, type StudioClientImports } from "./studio-ui.js";

const studioRequire = createRequire(import.meta.url);

export interface StudioOptions {
  readonly root: string;
  readonly path: string;
  readonly mode: StyleMode;
  readonly modeReason?: string;
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
  readonly mode?: StyleMode;
  readonly hostCss?: string;
  readonly port: number;
  readonly open: boolean;
  readonly help: boolean;
}

interface StudioArgumentError {
  readonly error: string;
}

interface StudioState {
  sourcePath: string;
  diskSource: string;
  draftSource: string;
  previewSource: string;
  diskVersion: string;
  previewVersion: number;
  mode: StyleMode;
  modeReason: string;
  lineEnding: "\n" | "\r\n";
  dirty: boolean;
  conflict: boolean;
  diagnostics: StudioDiagnostic[];
  revision: number;
  richProjection: RichProjection | undefined;
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
  --mode <mode>     Override detected foundation, default, or tailwind CSS.
  --host-css <path> Load one explicit local host stylesheet.
  --port <number>   Use a specific loopback port (default: 4317).
  --no-open         Do not open the system browser automatically.
  -h, --help        Show this command help.
`;

export function parseStudioArguments(args: readonly string[]): StudioArguments | StudioArgumentError {
  let path: string | undefined;
  let mode: StyleMode | undefined;
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

  if (help) return { path: path ?? "", port, open, help, ...(mode === undefined ? {} : { mode }), ...(hostCss === undefined ? {} : { hostCss }) };
  if (path === undefined) return { error: "Expected one Markdown or MDX source file." };
  if (!articleExtensions.has(extname(path).toLowerCase())) return { error: "Studio source must use a .md or .mdx extension." };
  return { path, port, open, help, ...(mode === undefined ? {} : { mode }), ...(hostCss === undefined ? {} : { hostCss }) };
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
    sourcePath: normalizePath(relative(root, sourcePath)),
    diskSource,
    draftSource: diskSource,
    previewSource: diskSource,
    diskVersion: fingerprint(diskSource),
    previewVersion: 1,
    mode: options.mode,
    modeReason: options.modeReason ?? "Selected explicitly by the Studio caller.",
    lineEnding: diskSource.includes("\r\n") ? "\r\n" : "\n",
    dirty: false,
    conflict: false,
    diagnostics: await diagnosticsFor(sourcePath, diskSource),
    revision: 1,
    richProjection: undefined
  };

  const articleId = `${sourcePath}.scribe-studio.mdx`;
  const runtime = studioRuntimePaths();
  let server: ViteDevServer;
  const httpServer = createHttpServer((request, response) => {
    server.middlewares(request, response, (error: unknown) => {
      if (response.writableEnded) return;
      response.statusCode = error === undefined ? 404 : 500;
      response.end(error === undefined ? "Not found." : "Scribe Studio request failed.");
    });
  });
  const studioPlugin = createStudioPlugin({ root, sourcePath, articleId, state, runtime, ...(hostCss === undefined ? {} : { hostCss }) });
  server = await createViteServer({
    configFile: false,
    root,
    appType: "custom",
    server: {
      middlewareMode: true,
      host: "127.0.0.1",
      port: options.port,
      strictPort: options.port !== 0,
      open: false,
      hmr: false,
      fs: { strict: true, allow: [root, ...Object.values(runtime).map(dirname)] }
    },
    resolve: {
      alias: studioAliases(runtime),
      dedupe: ["react", "react-dom"]
    },
    optimizeDeps: {
      include: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "@base-ui/react/button",
        "@base-ui/react/toggle",
        "@base-ui/react/toggle-group",
        "@base-ui/react/tooltip",
        "@mdxeditor/editor",
        "class-variance-authority",
        "clsx",
        "lenis",
        "lucide-react",
        "sonner",
        "tailwind-merge"
      ]
    },
    plugins: [studioPlugin, { ...mdx(createScribeMdxOptions()), enforce: "pre" }, react()]
  });

  try {
    await listenOnLoopback(httpServer, options.port);
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
      state.revision += 1;
      state.richProjection = undefined;
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

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    await closeStudioServers(server, httpServer);
    throw new Error("Scribe Studio did not expose a local HTTP address.");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  if (options.open) openBrowser(origin);
  return { origin, close: async () => closeStudioServers(server, httpServer) };
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

  let mode: StyleMode;
  let modeReason: string;
  try {
    const resolution = await resolveProjectStyleMode(dependencies.cwd ?? process.cwd(), parsed.mode);
    if (resolution.mode === undefined || resolution.ambiguities.length > 0) {
      stderr(`${resolution.ambiguities.join("\n")}\n`);
      return 2;
    }
    mode = resolution.mode;
    modeReason = resolution.reason;
  } catch (error) {
    stderr(`Could not detect the Studio style mode: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  let handle: StudioHandle;
  try {
    handle = await startStudio({
      root: dependencies.cwd ?? process.cwd(),
      path: parsed.path,
      mode,
      modeReason,
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
  const virtualDirectory = dirname(fileURLToPath(import.meta.url));
  const clientId = normalizePath(resolve(virtualDirectory, "studio-client.virtual.tsx"));
  const stylesId = normalizePath(resolve(virtualDirectory, "studio-styles.virtual.css"));
  return {
    name: "scribe-studio",
    enforce: "pre",
    resolveId(id) {
      if (id === "/@scribe-studio/preview.tsx") return previewId;
      if (id === "/@scribe-studio/client.tsx") return clientId;
      if (id === "/@scribe-studio/styles.css") return stylesId;
      if (id === "virtual:scribe-studio-article") return context.articleId;
      return undefined;
    },
    load(id) {
      if (id === context.articleId) return context.state.previewSource;
      if (id === previewId) return previewModule(context.state.mode, context.runtime, context.hostCss);
      if (id === clientId) return studioClientModule(context.runtime);
      if (id === stylesId) return studioStyles();
      return undefined;
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/__scribe/api/asset" && request.method === "GET") {
          return json(response, 200, { exists: await publicAssetExists(context.root, url.searchParams.get("path")) });
        }
        if (url.pathname === "/__scribe/api/document" && request.method === "GET") {
          return json(response, 200, publicState(context.state));
        }
        if (url.pathname === "/__scribe/api/rich-projection" && request.method === "GET") {
          if (context.state.diagnostics.some(({ severity }) => severity === "error")) {
            return json(response, 422, {
              error: "Fix Markdown diagnostics before entering Rich Text mode.",
              ...publicState(context.state)
            });
          }
          try {
            const projection = await ensureRichProjection(context.state);
            return json(response, 200, {
              projectionMarkdown: projection.projectionMarkdown,
              islands: projection.islands,
              revision: context.state.revision
            });
          } catch (error) {
            return json(response, 422, { error: error instanceof Error ? error.message : String(error), ...publicState(context.state) });
          }
        }
        if (url.pathname === "/__scribe/api/draft" && request.method === "PUT") {
          try {
            const body = await readJsonBody(request) as { source?: unknown };
            if (typeof body.source !== "string") {
              return json(response, 400, { error: "Draft requires string source." });
            }
            await applyDraft(context, server, previewId, normalizeLineEndings(body.source, context.state.lineEnding));
            context.state.revision += 1;
            context.state.richProjection = undefined;
            const hasErrors = context.state.diagnostics.some(({ severity }) => severity === "error");
            return json(response, 200, { ok: !hasErrors, ...publicState(context.state) });
          } catch (error) {
            return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (url.pathname === "/__scribe/api/rich-draft" && request.method === "PUT") {
          try {
            const body = await readJsonBody(request) as { source?: unknown; revision?: unknown };
            if (typeof body.source !== "string" || !Number.isInteger(body.revision)) {
              return json(response, 400, { error: "Rich Text draft requires string source and an integer revision." });
            }
            if (body.revision !== context.state.revision) {
              return json(response, 409, {
                ok: false,
                code: "SCB_RICH_STALE_PROJECTION",
                error: "The Markdown draft changed after Rich Text mode opened. Reload Rich Text from the current draft.",
                ...publicState(context.state)
              });
            }
            const projection = await ensureRichProjection(context.state);
            const result = await acceptRichCandidate(projection, body.source, context.sourcePath);
            if (!result.ok) {
              return json(response, 422, {
                ok: false,
                code: result.code,
                error: result.message,
                ...(result.islandId === undefined ? {} : { islandId: result.islandId }),
                projectionMarkdown: projection.projectionMarkdown,
                islands: projection.islands,
                ...publicState(context.state)
              });
            }
            await applyDraft(context, server, previewId, normalizeLineEndings(result.markdown, context.state.lineEnding));
            context.state.revision += 1;
            context.state.richProjection = await createRichProjection(context.state.draftSource);
            return json(response, 200, {
              ok: true,
              projectionMarkdown: context.state.richProjection.projectionMarkdown,
              islands: context.state.richProjection.islands,
              ...publicState(context.state)
            });
          } catch (error) {
            return json(response, 422, { ok: false, error: error instanceof Error ? error.message : String(error), ...publicState(context.state) });
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
          context.state.revision += 1;
          context.state.richProjection = undefined;
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

interface StudioRuntimePaths extends StudioClientImports {
  readonly scribeReact: string;
  readonly foundation: string;
  readonly default: string;
  readonly tailwind: string;
  readonly plexSans400: string;
  readonly plexSans500: string;
  readonly plexSans600: string;
  readonly plexSerif400: string;
  readonly plexSerif400Italic: string;
  readonly plexSerif600: string;
  readonly plexMono400: string;
  readonly plexMono500: string;
  readonly plexMono600: string;
}

function studioRuntimePaths(): StudioRuntimePaths {
  return {
    react: studioImportPath("react"),
    reactDom: studioImportPath("react-dom/client"),
    reactDomRoot: studioImportPath("react-dom"),
    reactJsxRuntime: studioImportPath("react/jsx-runtime"),
    reactJsxDevRuntime: studioImportPath("react/jsx-dev-runtime"),
    baseButton: studioImportPath("@base-ui/react/button"),
    baseToggle: studioImportPath("@base-ui/react/toggle"),
    baseToggleGroup: studioImportPath("@base-ui/react/toggle-group"),
    baseTooltip: studioImportPath("@base-ui/react/tooltip"),
    cva: studioImportPath("class-variance-authority"),
    clsx: studioImportPath("clsx"),
    lenis: studioImportPath("lenis"),
    lucide: studioImportPath("lucide-react"),
    sonner: studioImportPath("sonner"),
    tailwindMerge: studioImportPath("tailwind-merge"),
    mdxEditor: studioImportPath("@mdxeditor/editor"),
    mdxEditorStyle: studioImportPath("@mdxeditor/editor/style.css"),
    plexSans400: studioImportPath("@fontsource/ibm-plex-sans/400.css"),
    plexSans500: studioImportPath("@fontsource/ibm-plex-sans/500.css"),
    plexSans600: studioImportPath("@fontsource/ibm-plex-sans/600.css"),
    plexSerif400: studioImportPath("@fontsource/ibm-plex-serif/400.css"),
    plexSerif400Italic: studioImportPath("@fontsource/ibm-plex-serif/400-italic.css"),
    plexSerif600: studioImportPath("@fontsource/ibm-plex-serif/600.css"),
    plexMono400: studioImportPath("@fontsource/ibm-plex-mono/400.css"),
    plexMono500: studioImportPath("@fontsource/ibm-plex-mono/500.css"),
    plexMono600: studioImportPath("@fontsource/ibm-plex-mono/600.css"),
    scribeReact: studioRequire.resolve("@scribe-sdk/react"),
    foundation: studioRequire.resolve("@scribe-sdk/styles/foundation.css"),
    default: studioRequire.resolve("@scribe-sdk/styles/default.css"),
    tailwind: studioRequire.resolve("@scribe-sdk/styles/tailwind.css")
  };
}

function studioAliases(runtime: StudioRuntimePaths) {
  return [
    { find: "react/jsx-dev-runtime", replacement: runtime.reactJsxDevRuntime },
    { find: "react/jsx-runtime", replacement: runtime.reactJsxRuntime },
    { find: "react-dom/client", replacement: runtime.reactDom },
    { find: /^react-dom$/u, replacement: runtime.reactDomRoot },
    { find: /^react$/u, replacement: runtime.react },
    { find: "@base-ui/react/button", replacement: runtime.baseButton },
    { find: "@base-ui/react/toggle", replacement: runtime.baseToggle },
    { find: "@base-ui/react/toggle-group", replacement: runtime.baseToggleGroup },
    { find: "@base-ui/react/tooltip", replacement: runtime.baseTooltip },
    { find: "class-variance-authority", replacement: runtime.cva },
    { find: "clsx", replacement: runtime.clsx },
    { find: "lenis", replacement: runtime.lenis },
    { find: "lucide-react", replacement: runtime.lucide },
    { find: "sonner", replacement: runtime.sonner },
    { find: "tailwind-merge", replacement: runtime.tailwindMerge },
    { find: "@mdxeditor/editor/style.css", replacement: runtime.mdxEditorStyle },
    { find: "@mdxeditor/editor", replacement: runtime.mdxEditor },
    { find: "@fontsource/ibm-plex-sans/400.css", replacement: runtime.plexSans400 },
    { find: "@fontsource/ibm-plex-sans/500.css", replacement: runtime.plexSans500 },
    { find: "@fontsource/ibm-plex-sans/600.css", replacement: runtime.plexSans600 },
    { find: "@fontsource/ibm-plex-serif/400.css", replacement: runtime.plexSerif400 },
    { find: "@fontsource/ibm-plex-serif/400-italic.css", replacement: runtime.plexSerif400Italic },
    { find: "@fontsource/ibm-plex-serif/600.css", replacement: runtime.plexSerif600 },
    { find: "@fontsource/ibm-plex-mono/400.css", replacement: runtime.plexMono400 },
    { find: "@fontsource/ibm-plex-mono/500.css", replacement: runtime.plexMono500 },
    { find: "@fontsource/ibm-plex-mono/600.css", replacement: runtime.plexMono600 }
  ];
}

function studioImportPath(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier));
}

function previewModule(mode: StyleMode, runtime: StudioRuntimePaths, hostCss?: string): string {
  const hostImport = hostCss === undefined ? "" : `import ${JSON.stringify(`/@fs/${normalizePath(hostCss)}`)};`;
  const moduleImport = (path: string) => JSON.stringify(`/@fs/${normalizePath(path)}`);
  return `import * as React from "react";
import { createRoot } from "react-dom/client";
import Lenis from "lenis";
import { Banner, Publication, ScribeImage, createScribeComponents } from ${moduleImport(runtime.scribeReact)};
import ${moduleImport(runtime.plexSans400)};
import ${moduleImport(runtime.plexSans500)};
import ${moduleImport(runtime.plexSans600)};
import ${moduleImport(runtime.plexSerif400)};
import ${moduleImport(runtime.plexSerif400Italic)};
import ${moduleImport(runtime.plexSerif600)};
import ${moduleImport(runtime.plexMono400)};
import ${moduleImport(runtime.plexMono500)};
import ${moduleImport(runtime.plexMono600)};
import ${moduleImport(runtime[mode])};
${hostImport}
import Article from "virtual:scribe-studio-article";
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
function Wrapper(props) { return React.createElement(Publication, { ...props, "data-theme": theme }); }
function MissingAsset({ path, kind = "image" }) {
  return React.createElement("div", { className: "scribe-studio-missing-asset", role: "status" },
    React.createElement("strong", null, kind === "banner" ? "Banner image not found" : "Image not found"),
    React.createElement("code", null, path)
  );
}
function StudioBanner(props) {
  const [available, setAvailable] = React.useState(props.image === undefined ? true : null);
  React.useEffect(() => {
    if (props.image === undefined) { setAvailable(true); return; }
    const controller = new AbortController();
    fetch("/__scribe/api/asset?path=" + encodeURIComponent(props.image), { signal: controller.signal })
      .then((response) => response.json())
      .then((result) => setAvailable(result.exists === true))
      .catch((error) => { if (error.name !== "AbortError") setAvailable(false); });
    return () => controller.abort();
  }, [props.image]);
  if (props.image === undefined || available === true) return React.createElement(Banner, props);
  const { image, imageAlt, children, ...withoutImage } = props;
  return React.createElement(Banner, withoutImage, children,
    available === false
      ? React.createElement(MissingAsset, { path: image, kind: "banner" })
      : React.createElement("div", { className: "scribe-studio-missing-asset", "data-loading": "" }, "Checking banner image…")
  );
}
function StudioImage(props) {
  const [missing, setMissing] = React.useState(false);
  if (missing) return React.createElement(MissingAsset, { path: props.src || "Unknown source" });
  return React.createElement(ScribeImage, { ...props, onError: () => setMissing(true) });
}
if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
  new Lenis({ autoRaf: true, smoothWheel: true, gestureOrientation: "vertical", anchors: true });
}
const components = createScribeComponents({ components: { wrapper: Wrapper, Banner: StudioBanner, img: StudioImage } });
createRoot(document.querySelector("#preview")).render(React.createElement(Article, { components }));
`;
}

function studioHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scribe Studio</title></head><body><div id="scribe-studio"></div><script type="module" src="/@scribe-studio/client.tsx"></script></body></html>`;
}

function previewHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:light dark}body{--font-body:"IBM Plex Sans","Geist Sans",ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--font-heading:var(--font-body);--font-mono:"IBM Plex Mono","Geist Mono",ui-monospace,"SFMono-Regular",Consolas,monospace;margin:0;padding:clamp(1rem,4vw,3rem);background:#fff;color:#171716;font-family:var(--font-body)}body:has(.scribe[data-theme=dark]){background:#101112;color:#eeece8}.scribe-studio-missing-asset{display:grid;gap:.35rem;align-content:center;min-block-size:7rem;margin-block:1rem;padding:1rem;border:1px dashed color-mix(in oklab,currentColor 30%,transparent);border-radius:.55rem;color:color-mix(in oklab,currentColor 72%,transparent);background:color-mix(in oklab,currentColor 5%,transparent);font:500 .8rem/1.45 var(--font-body)}.scribe-studio-missing-asset strong{color:inherit}.scribe-studio-missing-asset code{overflow-wrap:anywhere;color:inherit;font-family:var(--font-mono)}.scribe-studio-missing-asset[data-loading]{opacity:.65}</style></head><body><div id="preview"></div><script type="module" src="/@scribe-studio/preview.tsx"></script></body></html>`;
}

function publicState(state: StudioState) {
  return {
    source: state.draftSource,
    sourcePath: state.sourcePath,
    diskVersion: state.diskVersion,
    previewVersion: state.previewVersion,
    mode: state.mode,
    modeReason: state.modeReason,
    dirty: state.dirty,
    conflict: state.conflict,
    diagnostics: state.diagnostics,
    revision: state.revision,
    frontmatter: frontmatter(state.draftSource)
  };
}

async function ensureRichProjection(state: StudioState): Promise<RichProjection> {
  state.richProjection ??= await createRichProjection(state.draftSource);
  return state.richProjection;
}

async function applyDraft(
  context: { readonly sourcePath: string; readonly articleId: string; readonly state: StudioState },
  server: ViteDevServer,
  previewId: string,
  source: string
): Promise<void> {
  context.state.draftSource = source;
  context.state.dirty = source !== context.state.diskSource;
  context.state.diagnostics = await diagnosticsFor(context.sourcePath, source);
  if (context.state.diagnostics.some(({ severity }) => severity === "error")) return;
  context.state.previewSource = source;
  context.state.previewVersion += 1;
  invalidateArticle(server, context.articleId);
  const preview = server.moduleGraph.getModuleById(previewId);
  if (preview) server.moduleGraph.invalidateModule(preview);
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

async function publicAssetExists(root: string, requestedPath: string | null): Promise<boolean> {
  if (requestedPath === null || !requestedPath.startsWith("/") || requestedPath.startsWith("//") || requestedPath.includes("\\")) {
    return false;
  }
  const publicRoot = resolve(root, "public");
  const assetPath = resolve(publicRoot, `.${requestedPath}`);
  try {
    assertWithinWorkspace(publicRoot, assetPath, "Public asset");
    return (await stat(assetPath)).isFile();
  } catch {
    return false;
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

async function listenOnLoopback(server: HttpServer, port: number): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const reject = (error: Error) => rejectListen(error);
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

async function closeStudioServers(vite: ViteDevServer, http: HttpServer): Promise<void> {
  try {
    await vite.close();
  } finally {
    if (!http.listening) return;
    await new Promise<void>((resolveClose, rejectClose) => {
      http.close((error) => error === undefined ? resolveClose() : rejectClose(error));
    });
  }
}
