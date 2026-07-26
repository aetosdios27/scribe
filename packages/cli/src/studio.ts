import { spawn } from "node:child_process";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import mdx from "@mdx-js/rollup";
import { createScribeMdxOptions } from "@scribe-sdk/mdx";
import react from "@vitejs/plugin-react";
import {
  createServer as createViteServer,
  normalizePath,
  transformWithOxc,
  type Plugin,
  type ViteDevServer
} from "vite";

import { displayPath, suggestClosest } from "./cli-output.js";
import { resolveProjectStyleMode, type StyleMode } from "./init.js";
import {
  durableWriteStudioFile,
  readStudioFile,
  StudioFileConflictError,
  type StudioFileSnapshot
} from "./studio-files.js";
import { StudioCompiler, type StudioCompilerDiagnostic } from "./studio-compiler.js";
import { StudioEventHub } from "./studio-events.js";
import {
  acceptRichCandidate,
  createRichProjection,
  type RichCandidateResult,
  type RichProjection
} from "./rich-preservation.js";
import { StudioWriterLease } from "./studio-lease.js";
import { StudioRecoveryStore, studioRecoveryKey, type StudioRecoveryRecord } from "./studio-recovery.js";
import { authorizeStudioMutation, createStudioSession, studioSessionHeader, type StudioSession } from "./studio-security.js";
import {
  StudioTransactionCoordinator,
  type StudioMutationRequest,
  type StudioMutationResult
} from "./studio-transactions.js";
import { studioClientModule, studioStyles, type StudioClientImports } from "./studio-ui.js";

const studioRequire = createRequire(import.meta.url);

const studioTailwindArticleClassName =
  "prose max-w-none text-[15px] leading-relaxed prose-p:text-[var(--text)] prose-headings:text-[var(--text)] prose-headings:font-bold prose-headings:tracking-tight prose-a:text-[var(--text)] prose-a:underline-offset-4 hover:prose-a:opacity-70 prose-strong:text-[var(--text)] prose-blockquote:border-l-[var(--text)] prose-blockquote:text-[var(--text)] prose-blockquote:opacity-80 prose-hr:border-[var(--text)]/20 prose-li:text-[var(--text)] prose-ul:text-[var(--text)] prose-img:border prose-img:border-[var(--text)]/20 prose-img:w-full [&_:not(pre)>code]:bg-[var(--text)] [&_:not(pre)>code]:text-[var(--bg)] [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:before:content-none [&_:not(pre)>code]:after:content-none";

export function studioPreviewArticleClassName(mode: StyleMode): string | undefined {
  return mode === "tailwind" ? studioTailwindArticleClassName : undefined;
}

export interface StudioOptions {
  readonly root: string;
  readonly path: string;
  readonly mode: StyleMode;
  readonly modeReason?: string;
  readonly hostCss?: string;
  readonly port: number;
  readonly open: boolean;
  /** Override used by isolated tests; normal sessions use the OS state directory. */
  readonly recoveryRoot?: string;
}

export interface StudioHandle {
  readonly origin: string;
  /** Internal capability used by Studio's own client and focused integration tests. */
  readonly sessionToken: string;
  readonly hasUnsavedChanges: () => boolean;
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
  fileSnapshot: StudioFileSnapshot;
  recoveryBaseVersion: string;
  recovered: boolean;
  recoveryConflict: boolean;
  discardRecoveryAvailable: boolean;
  recoveryKey: string;
}

type StudioDiagnostic = StudioCompilerDiagnostic;

interface StudioMutationHttpResult {
  readonly status: number;
  readonly error?: string;
}

interface RichMutationValue {
  readonly result: RichCandidateResult;
  readonly projection: RichProjection;
}

const styleModes = new Set<StyleMode>(["foundation", "default", "tailwind"]);
const articleExtensions = new Set([".md", ".mdx"]);
const maxRequestBytes = 5 * 1024 * 1024;

export const studioHelp = `Open Scribe's local, source-authoritative MDX Studio.

Usage
  scribe studio <article.mdx> [options]

Examples
  scribe studio ./content/article.mdx
  scribe studio ./content/article.mdx --mode foundation --no-open

Options
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
    } else if (argument?.startsWith("-")) {
      const suggestion = suggestClosest(argument, ["--mode", "--host-css", "--port", "--no-open", "--help"]);
      return { error: `Unknown studio option "${argument}".${suggestion === undefined ? "" : ` Did you mean "${suggestion}"?`}` };
    }
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
  const resolvedRoot = await realpath(root);
  const requestedSourcePath = resolve(root, options.path);
  assertWithinWorkspace(root, requestedSourcePath, "Source file");
  if (!articleExtensions.has(extname(requestedSourcePath).toLowerCase())) throw new Error("Studio source must use a .md or .mdx extension.");
  await access(requestedSourcePath, constants.R_OK | constants.W_OK);
  const fileSnapshot = await readStudioFile(requestedSourcePath);
  assertWithinWorkspace(resolvedRoot, fileSnapshot.resolvedPath, "Resolved source file");
  const sourcePath = fileSnapshot.resolvedPath;

  const hostCss = options.hostCss === undefined ? undefined : resolve(root, options.hostCss);
  if (hostCss !== undefined) {
    assertWithinWorkspace(root, hostCss, "Host CSS");
    if (extname(hostCss).toLowerCase() !== ".css") throw new Error("--host-css must reference a .css file.");
    await access(hostCss, constants.R_OK);
    assertWithinWorkspace(resolvedRoot, await realpath(hostCss), "Resolved host CSS");
  }

  const recovery = new StudioRecoveryStore(sourcePath, options.recoveryRoot);
  let recoveredDraft: StudioRecoveryRecord | undefined;
  try {
    recoveredDraft = await recovery.loadDraft();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(
      `Studio could not read its local recovery state${code === undefined ? "" : ` (${code})`}. Check the recovery directory permissions before reopening this article.`
    );
  }
  const runtime = studioRuntimePaths();
  const compiler = new StudioCompiler();
  const recoveryDraft = recoveredDraft?.sourcePath === sourcePath && recoveredDraft.draftSource !== fileSnapshot.source
    ? recoveredDraft
    : undefined;
  const canRecover = recoveryDraft !== undefined;
  const diskSource = fileSnapshot.source;
  const draftSource = recoveryDraft?.draftSource ?? diskSource;
  let initialDiagnostics: StudioDiagnostic[];
  try {
    initialDiagnostics = await diagnosticsFor(compiler, sourcePath, draftSource);
  } catch (error) {
    await compiler.close();
    throw error;
  }
  const recoveredPreview = initialDiagnostics.some(({ severity }) => severity === "error") ? diskSource : draftSource;
  const state: StudioState = {
    sourcePath: normalizePath(relative(root, requestedSourcePath)),
    diskSource,
    draftSource,
    previewSource: recoveredPreview,
    diskVersion: fileSnapshot.version,
    previewVersion: 1,
    mode: options.mode,
    modeReason: options.modeReason ?? "Selected explicitly by the Studio caller.",
    lineEnding: fileSnapshot.lineEnding,
    dirty: draftSource !== diskSource,
    conflict: Boolean(recoveryDraft && recoveryDraft.baseDiskVersion !== fileSnapshot.version),
    diagnostics: initialDiagnostics,
    revision: recoveryDraft ? Math.max(1, recoveryDraft.revision) : 1,
    richProjection: undefined,
    fileSnapshot,
    recoveryBaseVersion: recoveryDraft?.baseDiskVersion ?? fileSnapshot.version,
    recovered: Boolean(canRecover),
    recoveryConflict: Boolean(recoveryDraft && recoveryDraft.baseDiskVersion !== fileSnapshot.version),
    discardRecoveryAvailable: false,
    recoveryKey: studioRecoveryKey(sourcePath)
  };
  const coordinator = new StudioTransactionCoordinator(state.revision);
  const session = createStudioSession();
  const lease = new StudioWriterLease();
  const events = new StudioEventHub();

  const articleId = `${sourcePath}.scribe-studio.mdx`;
  let server: ViteDevServer;
  const httpServer = createHttpServer((request, response) => {
    server.middlewares(request, response, (error: unknown) => {
      if (response.writableEnded) return;
      response.statusCode = error === undefined ? 404 : 500;
      response.end(error === undefined ? "Not found." : "Scribe Studio request failed.");
    });
  });
  const studioPlugin = createStudioPlugin({
    root,
    sourcePath,
    requestedSourcePath,
    articleId,
    state,
    runtime,
    coordinator,
    session,
    lease,
    recovery,
    compiler,
    events,
    ...(hostCss === undefined ? {} : { hostCss })
  });
  try {
    const scribeMdxOptions = createScribeMdxOptions();
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
      hmr: { server: httpServer },
      fs: { strict: true, allow: [root, ...Object.values(runtime).map(dirname)] }
    },
    resolve: {
      alias: studioAliases(runtime),
      dedupe: ["react", "react-dom"]
    },
    optimizeDeps: {
      noDiscovery: true,
      holdUntilCrawlEnd: false,
      include: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "@cloudflare/kumo",
        "@mdxeditor/editor",
        "lenis",
        "lucide-react",
        "sonner"
      ]
    },
      plugins: [
        studioPlugin,
        {
          ...mdx({
            ...scribeMdxOptions,
            rehypePlugins: [...scribeMdxOptions.rehypePlugins, rehypeStudioSourceLines],
            recmaPlugins: [recmaStudioRefreshBoundary]
          }),
          enforce: "pre"
        },
        react({ include: /\.(mdx|js|jsx|ts|tsx)$/u })
      ]
    });
  } catch (error) {
    await compiler.close();
    throw error;
  }

  try {
    await listenOnLoopback(httpServer, options.port);
  } catch (error) {
    await Promise.all([server.close(), compiler.close()]);
    throw new Error(`Could not start Scribe Studio on 127.0.0.1:${options.port}: ${error instanceof Error ? error.message : String(error)}`);
  }

  server.watcher.add(sourcePath);
  const handleExternalChange = (path: string) => {
    if (resolve(path) !== sourcePath) return;
    void coordinator.system(async (nextRevision) => {
      let snapshot: StudioFileSnapshot;
      try {
        snapshot = await readStudioFile(requestedSourcePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { changed: false as const, value: undefined };
        }
        throw error;
      }
      if (snapshot.resolvedPath !== sourcePath) {
        state.revision = nextRevision;
        state.conflict = true;
        state.recoveryConflict = true;
        state.diagnostics = [sourceTargetChangedDiagnostic()];
        return { changed: true as const, value: undefined };
      }
      const source = snapshot.source;
      if (snapshot.version === state.diskVersion) {
        return { changed: false as const, value: undefined };
      }
      const wasClean = !state.dirty;
      const diagnostics = wasClean
        ? await diagnosticsFor(compiler, sourcePath, source)
        : state.diagnostics;
      state.revision = nextRevision;
      state.fileSnapshot = snapshot;
      state.diskSource = source;
      state.diskVersion = snapshot.version;
      state.lineEnding = snapshot.lineEnding;
      if (wasClean) {
        state.draftSource = source;
        state.previewSource = source;
        state.diagnostics = diagnostics;
        state.previewVersion += 1;
        state.richProjection = undefined;
        state.recoveryBaseVersion = snapshot.version;
        state.recovered = false;
        state.recoveryConflict = false;
        await reloadArticleSafely(server, articleId, state);
      } else {
        state.conflict = true;
        state.recoveryConflict = true;
      }
      return { changed: true as const, value: undefined };
    }).then(({ changed, revision }) => {
      state.revision = revision;
      if (changed) events.publish(revision);
    }).catch((error: unknown) => {
      state.conflict = true;
      state.diagnostics = [watcherDiagnostic(error)];
      events.publish(state.revision);
    });
  };
  server.watcher.on("change", handleExternalChange);
  server.watcher.on("add", handleExternalChange);
  server.watcher.on("unlink", (path) => {
    if (resolve(path) !== sourcePath) return;
    void coordinator.system(async (nextRevision) => {
      state.revision = nextRevision;
      state.conflict = true;
      state.diagnostics = [missingSourceDiagnostic()];
      return { changed: true as const, value: undefined };
    }).then(({ revision }) => {
      state.revision = revision;
      events.publish(revision);
    });
  });
  server.watcher.on("error", (error) => {
    void coordinator.system(async (nextRevision) => {
      state.revision = nextRevision;
      state.conflict = true;
      state.diagnostics = [watcherDiagnostic(error)];
      return { changed: true as const, value: undefined };
    }).then(({ revision }) => {
      state.revision = revision;
      events.publish(revision);
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    await closeStudioServers(server, httpServer, compiler);
    throw new Error("Scribe Studio did not expose a local HTTP address.");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  session.origin = origin;
  if (options.open) openBrowser(origin);
  return {
    origin,
    sessionToken: session.token,
    hasUnsavedChanges: () => state.dirty,
    close: async () => {
      events.close();
      await closeStudioServers(server, httpServer, compiler);
    }
  };
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

  stdout(formatStudioStartup(dependencies.cwd ?? process.cwd(), parsed.path, mode, handle.origin));
  await new Promise<void>((resolveStop) => {
    const stop = () => resolveStop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  if (handle.hasUnsavedChanges()) {
    stderr("Studio stopped with an unsaved draft. It was preserved in local recovery storage and will be offered when this article is reopened.\n");
  }
  await handle.close();
  return 0;
}

export function formatStudioStartup(root: string, sourcePath: string, mode: StyleMode, origin: string): string {
  const source = displayPath(root, resolve(root, sourcePath));
  return `Scribe Studio\n  ${origin}\n  Source  ${source}\n  Mode    ${mode}\n\nSource remains authoritative. Save explicitly from Studio or your editor.\nPress Ctrl+C to stop.\n`;
}

function createStudioPlugin(context: {
  readonly root: string;
  readonly sourcePath: string;
  readonly requestedSourcePath: string;
  readonly hostCss?: string;
  readonly articleId: string;
  readonly runtime: StudioRuntimePaths;
  readonly state: StudioState;
  readonly coordinator: StudioTransactionCoordinator;
  readonly session: StudioSession;
  readonly lease: StudioWriterLease;
  readonly recovery: StudioRecoveryStore;
  readonly compiler: StudioCompiler;
  readonly events: StudioEventHub;
}): Plugin {
  const previewId = "\0scribe-studio-preview.tsx";
  const clientId = "\0scribe-studio-client.tsx";
  const stylesId = "\0scribe-studio-styles.css";
  return {
    name: "scribe-studio",
    enforce: "pre",
    resolveId(id) {
      if (id === context.articleId) return context.articleId;
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
    async transform(code, id) {
      if (id !== clientId) return undefined;
      return transformWithOxc(code, "scribe-studio-client.tsx");
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (isStudioMutation(url.pathname, request.method)) {
          const authorizationError = authorizeStudioMutation(request, context.session);
          if (authorizationError !== undefined) {
            return json(response, 403, { error: authorizationError });
          }
        }
        if (url.pathname === "/__scribe/api/asset" && request.method === "GET") {
          return json(response, 200, { exists: await publicAssetExists(context.root, url.searchParams.get("path")) });
        }
        if (url.pathname === "/__scribe/api/document" && request.method === "GET") {
          return json(response, 200, publicState(context.state));
        }
        if (url.pathname === "/__scribe/api/events" && request.method === "GET") {
          response.statusCode = 200;
          response.setHeader("content-type", "text/event-stream; charset=utf-8");
          response.setHeader("cache-control", "no-store");
          response.setHeader("connection", "keep-alive");
          response.write(`data: ${context.state.revision}\n\n`);
          const unsubscribe = context.events.subscribe((revision) => response.write(`data: ${revision}\n\n`));
          const unsubscribeClose = context.events.onClose(() => response.end());
          const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
          request.once("close", () => {
            clearInterval(heartbeat);
            unsubscribe();
            unsubscribeClose();
          });
          return;
        }
        if (url.pathname === "/__scribe/api/lease" && request.method === "POST") {
          try {
            const body = await readJsonBody(request) as Record<string, unknown>;
            if (typeof body.clientId !== "string" || body.clientId.length < 1 || body.clientId.length > 128) {
              return json(response, 400, { error: "A writer lease requires a valid clientId." });
            }
            const lease = context.lease.acquire(body.clientId);
            return json(response, lease.granted ? 200 : 423, lease);
          } catch (error) {
            return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (url.pathname === "/__scribe/api/lease/release" && request.method === "POST") {
          try {
            const body = await readJsonBody(request) as Record<string, unknown>;
            if (typeof body.clientId !== "string") return json(response, 400, { error: "Lease release requires clientId." });
            context.lease.release(body.clientId);
            return json(response, 200, { released: true });
          } catch (error) {
            return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
          }
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
            const body = await readJsonBody(request) as Record<string, unknown>;
            const mutation = parseMutationRequest(body);
            if (typeof body.source !== "string" || mutation === undefined) {
              return json(response, 400, { error: mutationUsage("Draft requires string source.") });
            }
            if (!ensureWriter(context.lease, mutation.clientId)) return writerLocked(response);
            const result = await context.coordinator.mutate(mutation, async () => {
              const baseDiskVersion = typeof body.baseDiskVersion === "string"
                ? body.baseDiskVersion
                : context.state.recoveryBaseVersion;
              context.state.recoveryBaseVersion = baseDiskVersion;
              await applyDraft(context, server, normalizeLineEndings(body.source as string, context.state.lineEnding));
              if (body.externalConflict === true || baseDiskVersion !== context.state.diskVersion) {
                context.state.conflict = true;
                context.state.recoveryConflict = true;
              }
              context.state.richProjection = undefined;
              return { accepted: true as const, value: undefined };
            });
            if (result.kind === "stale") return staleMutation(response, context.state, result);
            context.state.revision = result.revision;
            context.events.publish(result.revision);
            const hasErrors = context.state.diagnostics.some(({ severity }) => severity === "error");
            return json(response, 200, { ok: !hasErrors, ...publicState(context.state) });
          } catch (error) {
            return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (url.pathname === "/__scribe/api/rich-draft" && request.method === "PUT") {
          try {
            const body = await readJsonBody(request) as Record<string, unknown>;
            const mutation = parseMutationRequest(body);
            if (typeof body.source !== "string" || mutation === undefined) {
              return json(response, 400, { error: mutationUsage("Rich Text draft requires string source.") });
            }
            if (!ensureWriter(context.lease, mutation.clientId)) return writerLocked(response);
            const transaction = await context.coordinator.mutate<RichMutationValue>(mutation, async () => {
              const baseSource = typeof body.baseSource === "string" ? body.baseSource : context.state.draftSource;
              const baseDiskVersion = typeof body.baseDiskVersion === "string"
                ? body.baseDiskVersion
                : context.state.recoveryBaseVersion;
              const projection = baseSource === context.state.draftSource
                ? await ensureRichProjection(context.state)
                : await createRichProjection(baseSource);
              let acceptedDiagnostics: StudioDiagnostic[] = [];
              const result = await acceptRichCandidate(
                projection,
                body.source as string,
                context.sourcePath,
                async ({ path, value }) => {
                  acceptedDiagnostics = await context.compiler.compile(path, value);
                  const error = acceptedDiagnostics.find(({ severity }) => severity === "error");
                  if (error !== undefined) {
                    throw Object.assign(new Error(error.message), {
                      ruleId: error.code,
                      ...(error.line === undefined ? {} : { line: error.line }),
                      ...(error.column === undefined ? {} : { column: error.column })
                    });
                  }
                }
              );
              if (!result.ok) return { accepted: false as const, value: { result, projection } };
              context.state.recoveryBaseVersion = baseDiskVersion;
              await applyDraft(
                context,
                server,
                normalizeLineEndings(result.markdown, context.state.lineEnding),
                acceptedDiagnostics
              );
              if (baseDiskVersion !== context.state.diskVersion) {
                context.state.conflict = true;
                context.state.recoveryConflict = true;
              }
              const nextProjection = await createRichProjection(context.state.draftSource);
              context.state.richProjection = nextProjection;
              return { accepted: true as const, value: { result, projection: nextProjection } };
            });
            if (transaction.kind === "stale") {
              return json(response, 409, {
                ok: false,
                code: "SCB_RICH_STALE_PROJECTION",
                error: "The Markdown draft changed after Rich Text mode opened. Reload Rich Text from the current draft.",
                ...publicStateWithRevision(context.state, transaction.revision)
              });
            }
            context.state.revision = transaction.revision;
            context.events.publish(transaction.revision);
            if (transaction.kind === "rejected") {
              const { result, projection } = transaction.value;
              if (result.ok) throw new Error("Studio rejected an accepted Rich Text candidate.");
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
            return json(response, 200, {
              ok: true,
              projectionMarkdown: transaction.value.projection.projectionMarkdown,
              islands: transaction.value.projection.islands,
              ...publicState(context.state)
            });
          } catch (error) {
            return json(response, 422, { ok: false, error: error instanceof Error ? error.message : String(error), ...publicState(context.state) });
          }
        }
        if (url.pathname === "/__scribe/api/save" && request.method === "PUT") {
          try {
            const body = await readJsonBody(request) as Record<string, unknown>;
            const mutation = parseMutationRequest(body);
            if (mutation === undefined) return json(response, 400, { error: mutationUsage("Save requires expectedDiskVersion.") });
            if (!ensureWriter(context.lease, mutation.clientId)) return writerLocked(response);
            const transaction = await context.coordinator.mutate<StudioMutationHttpResult>(mutation, async () => {
              let diskSnapshot: StudioFileSnapshot;
              try {
                diskSnapshot = await readStudioFile(context.requestedSourcePath);
              } catch {
                context.state.conflict = true;
                context.state.diagnostics = [missingSourceDiagnostic()];
                return { accepted: true as const, value: { status: 409, error: "The source file was deleted or renamed outside Studio. Restore it before saving." } };
              }
              if (diskSnapshot.resolvedPath !== context.sourcePath) {
                context.state.conflict = true;
                context.state.recoveryConflict = true;
                context.state.diagnostics = [sourceTargetChangedDiagnostic()];
                return { accepted: true as const, value: { status: 409, error: "The source symlink or file target changed outside Studio. The unsaved draft was not written." } };
              }
              if (
                body.expectedDiskVersion !== context.state.diskVersion
                || context.state.conflict
                || diskSnapshot.version !== body.expectedDiskVersion
              ) {
                context.state.fileSnapshot = diskSnapshot;
                context.state.diskSource = diskSnapshot.source;
                context.state.diskVersion = diskSnapshot.version;
                context.state.lineEnding = diskSnapshot.lineEnding;
                context.state.conflict = true;
                return { accepted: true as const, value: { status: 409, error: "The source changed outside Studio. Reload or reconcile before saving." } };
              }
              await context.recovery.writeHistory({
                sourcePath: context.sourcePath,
                baseDiskVersion: diskSnapshot.version,
                draftSource: diskSnapshot.source,
                revision: context.coordinator.revision
              }, "checkpoint");
              const committed = await durableWriteStudioFile({
                requestedPath: context.requestedSourcePath,
                resolvedPath: diskSnapshot.resolvedPath,
                expectedVersion: diskSnapshot.version,
                expectedDevice: diskSnapshot.device,
                expectedInode: diskSnapshot.inode,
                source: context.state.draftSource,
                lineEnding: diskSnapshot.lineEnding,
                bom: diskSnapshot.bom,
                mode: diskSnapshot.mode
              });
              context.state.fileSnapshot = committed;
              context.state.diskSource = committed.source;
              context.state.diskVersion = committed.version;
              context.state.lineEnding = committed.lineEnding;
              context.state.dirty = false;
              context.state.conflict = false;
              context.state.recoveryBaseVersion = committed.version;
              context.state.recovered = false;
              context.state.recoveryConflict = false;
              context.state.discardRecoveryAvailable = false;
              await context.recovery.archiveDraft("saved").catch(() => undefined);
              return { accepted: true as const, value: { status: 200 } };
            });
            if (transaction.kind === "stale") return staleMutation(response, context.state, transaction);
            context.state.revision = transaction.revision;
            context.events.publish(transaction.revision);
            return json(response, transaction.value.status, {
              ok: transaction.value.status === 200,
              ...(transaction.value.error === undefined ? {} : { error: transaction.value.error }),
              ...publicState(context.state)
            });
          } catch (error) {
            if (error instanceof StudioFileConflictError) {
              context.state.conflict = true;
              return json(response, 409, { error: error.message, ...publicState(context.state) });
            }
            return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (url.pathname === "/__scribe/api/discard" && request.method === "POST") {
          try {
            const body = await readJsonBody(request) as Record<string, unknown>;
            const mutation = parseMutationRequest(body);
            if (mutation === undefined) return json(response, 400, { error: mutationUsage("Discard requires a mutation envelope.") });
            if (!ensureWriter(context.lease, mutation.clientId)) return writerLocked(response);
            const transaction = await context.coordinator.mutate<StudioMutationHttpResult>(mutation, async () => {
              let diskSnapshot: StudioFileSnapshot;
              try {
                diskSnapshot = await readStudioFile(context.requestedSourcePath);
              } catch {
                context.state.conflict = true;
                context.state.diagnostics = [missingSourceDiagnostic()];
                return { accepted: true as const, value: { status: 409, error: "The source file was deleted or renamed outside Studio. The unsaved draft is still preserved." } };
              }
              if (diskSnapshot.resolvedPath !== context.sourcePath) {
                context.state.conflict = true;
                context.state.recoveryConflict = true;
                context.state.diagnostics = [sourceTargetChangedDiagnostic()];
                return { accepted: true as const, value: { status: 409, error: "The source symlink or file target changed outside Studio. The unsaved draft is still preserved." } };
              }
              const archived = await context.recovery.archiveDraft("discarded");
              context.state.fileSnapshot = diskSnapshot;
              context.state.diskSource = diskSnapshot.source;
              context.state.diskVersion = diskSnapshot.version;
              context.state.lineEnding = diskSnapshot.lineEnding;
              context.state.draftSource = diskSnapshot.source;
              context.state.previewSource = diskSnapshot.source;
              context.state.dirty = false;
              context.state.conflict = false;
              context.state.diagnostics = await diagnosticsFor(context.compiler, context.sourcePath, diskSnapshot.source);
              context.state.previewVersion += 1;
              context.state.richProjection = undefined;
              context.state.recoveryBaseVersion = diskSnapshot.version;
              context.state.recovered = false;
              context.state.recoveryConflict = false;
              context.state.discardRecoveryAvailable = archived !== undefined;
              await reloadArticleSafely(server, context.articleId, context.state);
              return { accepted: true as const, value: { status: 200 } };
            });
            if (transaction.kind === "stale") return staleMutation(response, context.state, transaction);
            context.state.revision = transaction.revision;
            context.events.publish(transaction.revision);
            return json(response, transaction.value.status, {
              ok: transaction.value.status === 200,
              ...(transaction.value.error === undefined ? {} : { error: transaction.value.error }),
              ...publicState(context.state)
            });
          } catch (error) {
            return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (url.pathname === "/__scribe/api/recover-discard" && request.method === "POST") {
          try {
            const body = await readJsonBody(request) as Record<string, unknown>;
            const mutation = parseMutationRequest(body);
            if (mutation === undefined) return json(response, 400, { error: mutationUsage("Recovery requires a mutation envelope.") });
            if (!ensureWriter(context.lease, mutation.clientId)) return writerLocked(response);
            const transaction = await context.coordinator.mutate<StudioMutationHttpResult>(mutation, async () => {
              const archived = await context.recovery.loadLatestArchive("discarded");
              if (archived === undefined || archived.sourcePath !== context.sourcePath) {
                return { accepted: false as const, value: { status: 404, error: "No discarded Studio draft is available to recover." } };
              }
              const previousBase = context.state.recoveryBaseVersion;
              context.state.recoveryBaseVersion = archived.baseDiskVersion;
              try {
                await applyDraft(context, server, archived.draftSource);
              } catch (error) {
                context.state.recoveryBaseVersion = previousBase;
                throw error;
              }
              context.state.recovered = true;
              context.state.recoveryConflict = archived.baseDiskVersion !== context.state.diskVersion;
              context.state.conflict ||= context.state.recoveryConflict;
              context.state.discardRecoveryAvailable = false;
              return { accepted: true as const, value: { status: 200 } };
            });
            if (transaction.kind === "stale") return staleMutation(response, context.state, transaction);
            context.state.revision = transaction.revision;
            context.events.publish(transaction.revision);
            return json(response, transaction.value.status, {
              ok: transaction.kind === "accepted",
              ...(transaction.value.error === undefined ? {} : { error: transaction.value.error }),
              ...publicState(context.state)
            });
          } catch (error) {
            return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (url.pathname === "/" || url.pathname === "/studio") {
          response.statusCode = 200;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(await server.transformIndexHtml(url.pathname, studioHtml(context.session.token)));
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
    kumo: studioImportPath("@cloudflare/kumo"),
    kumoStyle: studioImportPath("@cloudflare/kumo/styles/standalone"),
    lenis: studioImportPath("lenis"),
    lucide: studioImportPath("lucide-react"),
    sonner: studioImportPath("sonner"),
    mdxEditor: studioImportPath("@mdxeditor/editor"),
    mdxEditorStyle: studioImportPath("@mdxeditor/editor/style.css"),
    monaco: studioImportPath("monaco-editor"),
    monacoMarkdown: studioImportPath("monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js"),
    monacoWorker: studioRequire.resolve("monaco-editor/esm/vs/editor/editor.worker.js"),
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
    { find: /^@cloudflare\/kumo$/u, replacement: runtime.kumo },
    { find: "@cloudflare/kumo/styles/standalone", replacement: runtime.kumoStyle },
    { find: "lenis", replacement: runtime.lenis },
    { find: "lucide-react", replacement: runtime.lucide },
    { find: "sonner", replacement: runtime.sonner },
    { find: "@mdxeditor/editor/style.css", replacement: runtime.mdxEditorStyle },
    { find: "@mdxeditor/editor", replacement: runtime.mdxEditor },
    {
      find: /^monaco-editor\/esm\/vs\/editor\/editor\.worker\.js(?:\?worker)?$/u,
      replacement: `${runtime.monacoWorker}?worker`
    },
    {
      find: /^monaco-editor\/esm\/vs\/basic-languages\/markdown\/markdown\.contribution\.js$/u,
      replacement: runtime.monacoMarkdown
    },
    { find: /^monaco-editor$/u, replacement: runtime.monaco },
    { find: "@fontsource/ibm-plex-sans/400.css", replacement: runtime.plexSans400 },
    { find: "@fontsource/ibm-plex-sans/500.css", replacement: runtime.plexSans500 },
    { find: "@fontsource/ibm-plex-sans/600.css", replacement: runtime.plexSans600 },
    { find: "@fontsource/ibm-plex-serif/400.css", replacement: runtime.plexSerif400 },
    { find: "@fontsource/ibm-plex-serif/400-italic.css", replacement: runtime.plexSerif400Italic },
    { find: "@fontsource/ibm-plex-serif/600.css", replacement: runtime.plexSerif600 },
    { find: "@fontsource/ibm-plex-mono/400.css", replacement: runtime.plexMono400 },
    { find: "@fontsource/ibm-plex-mono/500.css", replacement: runtime.plexMono500 },
    { find: "@fontsource/ibm-plex-mono/600.css", replacement: runtime.plexMono600 },
    { find: "@scribe-sdk/styles/foundation.css", replacement: runtime.foundation },
    { find: "@scribe-sdk/styles/default.css", replacement: runtime.default },
    { find: "@scribe-sdk/styles/tailwind.css", replacement: runtime.tailwind }
  ];
}

function studioImportPath(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier));
}

const studioSourceMappedElements = new Set([
  "article", "aside", "blockquote", "div", "figure", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "li", "ol", "p", "pre", "section", "table", "ul"
]);

function rehypeStudioSourceLines() {
  return (tree: unknown) => {
    annotateStudioSourceLines(tree);
  };
}

function annotateStudioSourceLines(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) annotateStudioSourceLines(child);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  const position = node.position as { readonly start?: { readonly line?: unknown } } | undefined;
  const line = position?.start?.line;
  if (Number.isSafeInteger(line)) {
    if (node.type === "element" && typeof node.tagName === "string" && studioSourceMappedElements.has(node.tagName)) {
      const properties = (node.properties ??= {}) as Record<string, unknown>;
      properties["data-scribe-source-line"] = String(line);
    } else if (node.type === "mdxJsxFlowElement") {
      const attributes = Array.isArray(node.attributes) ? node.attributes : (node.attributes = []);
      attributes.push({
        type: "mdxJsxAttribute",
        name: "data-scribe-source-line",
        value: String(line)
      });
    }
  }
  for (const [key, child] of Object.entries(node)) {
    if (key !== "position") annotateStudioSourceLines(child);
  }
}

function recmaStudioRefreshBoundary() {
  return (tree: unknown) => {
    renameGeneratedMdxBody(tree);
  };
}

function renameGeneratedMdxBody(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) renameGeneratedMdxBody(child);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  if (node.type === "Identifier" && node.name === "_createMdxContent") {
    node.name = "MdxContentBody";
  }
  for (const child of Object.values(node)) renameGeneratedMdxBody(child);
}

function previewModule(mode: StyleMode, runtime: StudioRuntimePaths, hostCss?: string): string {
  const hostImport = hostCss === undefined ? "" : `import ${JSON.stringify(`/@fs/${normalizePath(hostCss)}`)};`;
  const hostArticleClassName = JSON.stringify(studioPreviewArticleClassName(mode));
  const mirrorsHostDarkClass = mode === "tailwind";
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
const studioHostArticleClassName = ${hostArticleClassName};
const studioMirrorsHostDarkClass = ${mirrorsHostDarkClass};
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
const previewRoot = createRoot(document.querySelector("#preview"));
function PreviewApp() {
  const [theme, setTheme] = React.useState("dark");
  React.useLayoutEffect(() => {
    if (!studioMirrorsHostDarkClass) return;
    document.documentElement.classList.toggle("dark", theme === "dark");
    return () => document.documentElement.classList.remove("dark");
  }, [theme]);
  React.useEffect(() => {
    const receiveTheme = (event) => {
      if (event.origin !== location.origin || event.data?.type !== "scribe:theme") return;
      if (event.data.theme === "light" || event.data.theme === "dark") setTheme(event.data.theme);
    };
    addEventListener("message", receiveTheme);
    return () => removeEventListener("message", receiveTheme);
  }, []);
  React.useEffect(() => {
    const receiveReveal = (event) => {
      if (event.origin !== location.origin || event.data?.type !== "scribe:reveal-source") return;
      const line = Number(event.data.line);
      if (!Number.isSafeInteger(line) || line < 1) return;
      const candidates = Array.from(document.querySelectorAll("[data-scribe-source-line]"));
      const target = candidates.reduce((closest, element) => {
        const elementLine = Number(element.getAttribute("data-scribe-source-line"));
        if (!Number.isSafeInteger(elementLine)) return closest;
        if (closest === null) return element;
        const closestLine = Number(closest.getAttribute("data-scribe-source-line"));
        const elementDistance = elementLine <= line ? line - elementLine : Number.POSITIVE_INFINITY;
        const closestDistance = closestLine <= line ? line - closestLine : Number.POSITIVE_INFINITY;
        return elementDistance < closestDistance ? element : closest;
      }, null);
      target?.scrollIntoView({
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "center"
      });
    };
    addEventListener("message", receiveReveal);
    return () => removeEventListener("message", receiveReveal);
  }, []);
  const components = React.useMemo(() => {
    function Wrapper({ children, ...props }) {
      const articleChildren = studioHostArticleClassName
        ? React.createElement("div", { className: studioHostArticleClassName, "data-scribe-studio-host-article": "" }, children)
        : children;
      return React.createElement(Publication, { ...props, "data-theme": theme }, articleChildren);
    }
    return createScribeComponents({ components: { wrapper: Wrapper, Banner: StudioBanner, img: StudioImage } });
  }, [theme]);
  return React.createElement(Article, { components });
}
previewRoot.render(React.createElement(PreviewApp));
`;
}

function studioHtml(sessionToken: string): string {
  return `<!doctype html><html lang="en" data-mode="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="scribe-studio-session" content="${sessionToken}"><title>Scribe Studio</title></head><body><div id="scribe-studio"></div><script type="module" src="/@scribe-studio/client.tsx"></script></body></html>`;
}

function previewHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:light dark}body{--font-body:"IBM Plex Sans","Geist Sans",ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--font-heading:var(--font-body);--font-mono:"IBM Plex Mono","Geist Mono",ui-monospace,"SFMono-Regular",Consolas,monospace;margin:0;padding:clamp(1rem,4vw,3rem);background:#fff;color:#171716;font-family:var(--font-body);transition:background-color 180ms ease,color 180ms ease}body:has(.scribe[data-theme=dark]){background:#101112;color:#eeece8}[data-scribe-studio-host-article] :where(table,table caption,table thead,table tbody,table tr,table th,table td,table p,table strong,table em,table a,.scribe-code-frame,.scribe-code-frame__header,.scribe-code-frame__pre,.scribe-code-frame__pre code,.scribe-code-frame__pre code *){color:#171716!important}html.dark [data-scribe-studio-host-article] :where(table,table caption,table thead,table tbody,table tr,table th,table td,table p,table strong,table em,table a,.scribe-code-frame,.scribe-code-frame__header,.scribe-code-frame__pre,.scribe-code-frame__pre code,.scribe-code-frame__pre code *){color:#f5f5f4!important}[data-scribe-studio-host-article] .scribe-banner__metadata{color:var(--text,#171716)!important}.scribe-studio-missing-asset{display:grid;gap:.35rem;align-content:center;min-block-size:7rem;margin-block:1rem;padding:1rem;border:1px dashed color-mix(in oklab,currentColor 30%,transparent);border-radius:.55rem;color:color-mix(in oklab,currentColor 72%,transparent);background:color-mix(in oklab,currentColor 5%,transparent);font:500 .8rem/1.45 var(--font-body)}.scribe-studio-missing-asset strong{color:inherit}.scribe-studio-missing-asset code{overflow-wrap:anywhere;color:inherit;font-family:var(--font-mono)}.scribe-studio-missing-asset[data-loading]{opacity:.65}@media(prefers-reduced-motion:reduce){body{transition:none}}</style></head><body><div id="preview"></div><script type="module" src="/@scribe-studio/preview.tsx"></script></body></html>`;
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
    recovered: state.recovered,
    recoveryConflict: state.recoveryConflict,
    discardRecoveryAvailable: state.discardRecoveryAvailable,
    recoveryKey: state.recoveryKey,
    diagnostics: state.diagnostics,
    revision: state.revision,
    frontmatter: frontmatter(state.draftSource)
  };
}

function publicStateWithRevision(state: StudioState, revision: number) {
  return { ...publicState(state), revision };
}

function isStudioMutation(pathname: string, method: string | undefined): boolean {
  return (method === "PUT" || method === "POST") && pathname.startsWith("/__scribe/api/");
}

function parseMutationRequest(body: Record<string, unknown>): StudioMutationRequest | undefined {
  if (
    typeof body.clientId !== "string"
    || body.clientId.length < 1
    || body.clientId.length > 128
    || typeof body.operationId !== "string"
    || body.operationId.length < 1
    || body.operationId.length > 128
    || !Number.isSafeInteger(body.baseRevision)
    || (body.baseRevision as number) < 0
  ) {
    return undefined;
  }
  return {
    clientId: body.clientId,
    operationId: body.operationId,
    baseRevision: body.baseRevision as number
  };
}

function mutationUsage(prefix: string): string {
  return `${prefix} Include clientId, operationId, and integer baseRevision from the current Studio document.`;
}

function ensureWriter(lease: StudioWriterLease, clientId: string): boolean {
  return lease.holds(clientId) || lease.acquire(clientId).granted;
}

function writerLocked(response: import("node:http").ServerResponse): void {
  json(response, 423, {
    ok: false,
    code: "SCB_STUDIO_WRITER_LOCKED",
    error: "Another Studio tab currently owns this draft. This tab remains read-only until that writer disconnects."
  });
}

function staleMutation(
  response: import("node:http").ServerResponse,
  state: StudioState,
  result: Extract<StudioMutationResult<unknown>, { readonly kind: "stale" }>
): void {
  json(response, 409, {
    ok: false,
    code: "SCB_STUDIO_STALE_REVISION",
    error: state.conflict
      ? "The source changed outside Studio. Reload or reconcile before retrying."
      : "The Studio draft changed before this operation was applied. Reload the current draft and retry.",
    ...publicStateWithRevision(state, result.revision)
  });
}

async function ensureRichProjection(state: StudioState): Promise<RichProjection> {
  state.richProjection ??= await createRichProjection(state.draftSource);
  return state.richProjection;
}

async function applyDraft(
  context: {
    readonly sourcePath: string;
    readonly articleId: string;
    readonly state: StudioState;
    readonly coordinator: StudioTransactionCoordinator;
    readonly recovery: StudioRecoveryStore;
    readonly compiler: StudioCompiler;
  },
  server: ViteDevServer,
  source: string,
  knownDiagnostics?: StudioDiagnostic[]
): Promise<void> {
  const dirty = source !== context.state.diskSource;
  const diagnostics = knownDiagnostics ?? await diagnosticsFor(context.compiler, context.sourcePath, source);
  if (dirty) {
    await context.recovery.writeDraft({
      sourcePath: context.sourcePath,
      baseDiskVersion: context.state.recoveryBaseVersion,
      draftSource: source,
      revision: context.coordinator.revision + 1
    });
  } else {
    await context.recovery.archiveDraft("reverted");
  }
  context.state.draftSource = source;
  context.state.dirty = dirty;
  context.state.diagnostics = diagnostics;
  context.state.recovered = false;
  context.state.recoveryConflict = context.state.conflict;
  if (diagnostics.some(({ severity }) => severity === "error")) return;
  context.state.previewSource = source;
  context.state.previewVersion += 1;
  await reloadArticleSafely(server, context.articleId, context.state);
}

async function diagnosticsFor(compiler: StudioCompiler, path: string, source: string): Promise<StudioDiagnostic[]> {
  return compiler.compile(path, source);
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

function missingSourceDiagnostic(): StudioDiagnostic {
  return {
    severity: "error",
    code: "SCB2001",
    message: "The source file was deleted or renamed outside Studio. Save is blocked until it is restored or the session is closed."
  };
}

function watcherDiagnostic(error: unknown): StudioDiagnostic {
  return {
    severity: "error",
    code: "SCB2002",
    message: `Studio could not process an external source change: ${error instanceof Error ? error.message : String(error)}`
  };
}

function sourceTargetChangedDiagnostic(): StudioDiagnostic {
  return {
    severity: "error",
    code: "SCB2003",
    message: "The source symlink or file target changed outside Studio. The current draft is preserved, but saving is blocked."
  };
}

function previewReloadDiagnostic(error: unknown): StudioDiagnostic {
  return {
    severity: "warning",
    code: "SCB2004",
    message: `The draft is preserved, but Studio could not refresh the preview: ${error instanceof Error ? error.message : String(error)}`
  };
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
    const [resolvedPublicRoot, resolvedAssetPath] = await Promise.all([realpath(publicRoot), realpath(assetPath)]);
    assertWithinWorkspace(resolvedPublicRoot, resolvedAssetPath, "Resolved public asset");
    return (await stat(resolvedAssetPath)).isFile();
  } catch {
    return false;
  }
}

async function reloadArticle(server: ViteDevServer, articleId: string): Promise<void> {
  const module = server.moduleGraph.getModuleById(articleId);
  if (module) await server.reloadModule(module);
}

async function reloadArticleSafely(server: ViteDevServer, articleId: string, state: StudioState): Promise<void> {
  try {
    await reloadArticle(server, articleId);
  } catch (error) {
    state.diagnostics = [...state.diagnostics, previewReloadDiagnostic(error)];
  }
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

async function closeStudioServers(vite: ViteDevServer, http: HttpServer, compiler: StudioCompiler): Promise<void> {
  http.closeIdleConnections();
  http.closeAllConnections();
  const httpClosed = !http.listening
    ? Promise.resolve()
    : new Promise<void>((resolveClose, rejectClose) => {
        http.close((error) => error === undefined ? resolveClose() : rejectClose(error));
      });
  try {
    await shutdownStep(compiler.close(), "compiler worker");
    await shutdownStep(vite.close(), "Vite server");
  } finally {
    await shutdownStep(httpClosed, "Studio HTTP server");
  }
}

async function shutdownStep(operation: Promise<unknown>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out closing the ${label}.`)), 3_000);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
