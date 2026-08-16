#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { compileScribeMdx } from "@scribe-sdk/mdx";
import {
  chooseContentDirectory,
  contentConventions,
  displayWorkspacePath
} from "./content-paths.js";
import { applyInitPlan, planInit } from "./init.js";
import {
  applyIntegratePlan,
  inspectProject,
  IntegrateOperationError,
  planIntegrate,
  recommendStyleMode,
  resolveProjectStyleMode,
  type StyleMode
} from "./integrate.js";
import { findSupportedProjectRoot } from "./launcher.js";
import { applyMediumImportPlan, planMediumImport } from "./medium-import.js";
import {
  detectPackageManagerContext,
  formatPackageCommand
} from "./package-manager.js";
import {
  createStudioArticle,
  deriveArticleSlug,
  planStudioArticle
} from "./studio-init.js";
import { startStudio } from "./studio.js";
import {
  applyScribeUpdatePlan,
  planScribeUpdate,
  UpdateOperationError
} from "./update.js";
import { checkPackageAlignment } from "./version-alignment.js";

const protocolVersion = 1;
const engineVersion = readPackageVersion();
const maxMessageBytes = 1024 * 1024;

interface RpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

interface StoredPlan {
  readonly method: string;
  readonly summary: PlanSummary;
  readonly apply: (operationId: string) => Promise<unknown>;
}

interface PlanSummary {
  readonly root: string;
  readonly mode?: string;
  readonly packages: readonly unknown[];
  readonly commands: readonly unknown[];
  readonly files: readonly { readonly path: string; readonly action: string }[];
  readonly warnings: readonly string[];
  readonly manualSteps: readonly string[];
  readonly values: Readonly<Record<string, unknown>>;
}

const plans = new Map<string, StoredPlan>();
let initialized = false;
let cwd = process.cwd();
let operationSequence = 0;

export async function runEngine(): Promise<void> {
  process.env.SCRIBE_ENGINE_PROTOCOL = "1";
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (Buffer.byteLength(line, "utf8") > maxMessageBytes) {
      writeError(null, -32_600, "Protocol message is too large.", "protocol");
      continue;
    }
    let request: RpcRequest;
    try {
      request = parseRequest(line);
    } catch (error) {
      writeError(null, -32_700, errorMessage(error), "protocol");
      continue;
    }
    try {
      const result = await dispatch(request);
      writeMessage({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      const failure = normalizeFailure(error);
      writeError(request.id, failure.code, failure.message, failure.kind, failure.recovery, failure.partialState);
    }
  }
}

async function dispatch(request: RpcRequest): Promise<unknown> {
  if (request.method === "initialize") return initialize(request.params);
  if (!initialized) throw protocolFailure("The engine must be initialized before use.");
  if (request.method === "status") return inspectStatus();
  if (request.method === "validate") {
    const params = record(request.params);
    const article = requiredString(params.article, "article");
    const path = resolve(cwd, article);
    const operationId = nextOperationId("validate");
    emitEvent(operationId, "task.started", { task: "Compile article" });
    const source = await readFile(path, "utf8");
    const file = await compileScribeMdx(
      { path, value: source },
      { strict: params.strict === true }
    );
    for (const message of file.messages) {
      emitEvent(operationId, "warning", {
        task: "Article warning",
        detail: formatDiagnostic(displayWorkspacePath(cwd, path), message)
      });
    }
    emitEvent(operationId, "task.completed", { task: "Compile article" });
    return {
      title: "Validation passed",
      values: { article: displayWorkspacePath(cwd, path), warnings: file.messages.length }
    };
  }
  if (request.method === "studioArticle.suggest") {
    const params = record(request.params);
    const title = requiredString(params.title, "title");
    const root = await findSupportedProjectRoot(cwd) ?? cwd;
    const slug = optionalString(params.slug) ?? deriveArticleSlug(title);
    const explicitPath = optionalString(params.path);
    const contentDirectory = explicitPath === undefined
      ? await chooseContentDirectory(root, optionalString(params.contentDirectory), "--content-dir")
      : undefined;
    const targetPath = explicitPath ?? (
      contentDirectory === undefined
        ? `${slug}.mdx`
        : displayWorkspacePath(root, resolve(contentDirectory, `${slug}.mdx`))
    );
    return {
      title: "Article defaults",
      values: {
        root,
        title,
        slug,
        targetPath,
        ...(contentDirectory === undefined
          ? {}
          : { contentDirectory: displayWorkspacePath(root, contentDirectory) })
      }
    };
  }
  if (request.method === "studio.start") {
    const params = record(request.params);
    const article = requiredString(params.article, "article");
    return runStudioSession(article, params, nextOperationId("studio"));
  }
  if (request.method.endsWith(".plan")) return createPlan(request.method, request.params);
  if (request.method.endsWith(".apply")) return applyPlan(request.method, request.params);
  if (request.method === "operation.cancel") {
    return { title: "Cancellation requested", message: "No active cancellable operation." };
  }
  throw rpcFailure(-32_601, `Unknown engine method ${JSON.stringify(request.method)}.`, "usage");
}

function initialize(paramsInput: unknown): unknown {
  const params = record(paramsInput);
  const requestedProtocol = requiredNumber(params.protocolVersion, "protocolVersion");
  const cliVersion = requiredString(params.cliVersion, "cliVersion");
  if (requestedProtocol !== protocolVersion) {
    throw rpcFailure(
      -32_003,
      `Unsupported protocol version ${requestedProtocol}; expected ${protocolVersion}.`,
      "protocol"
    );
  }
  if (cliVersion !== engineVersion) {
    throw rpcFailure(
      -32_003,
      `CLI ${cliVersion} and engine ${engineVersion} versions differ.`,
      "version",
      ["Install matching Scribe package versions."]
    );
  }
  cwd = requiredString(params.cwd, "cwd");
  initialized = true;
  return {
    protocolVersion,
    engineVersion,
    capabilities: [
      "status",
      "init",
      "integrate",
      "mediumImport",
      "studio",
      "studioArticle",
      "update",
      "validate"
    ]
  };
}

async function inspectStatus(): Promise<unknown> {
  const root = await findSupportedProjectRoot(cwd);
  if (root === undefined) {
    return {
      title: "Project status",
      message: "No supported React project was found.",
      values: { expected: "Next.js or Vite", help: "scribe --help" }
    };
  }
  const inspection = await inspectProject(root);
  const integrated = inspection.hasScribeCompiler || inspection.hasScribeComponents;
  const runtimePresent = ["@scribe-sdk/react", "@scribe-sdk/styles", "@scribe-sdk/mdx"]
    .every((name) => inspection.packageNames.has(name));
  const mode = recommendStyleMode(inspection).mode;
  const contentDirectory = await firstExistingContentDirectory(root);
  const values: Record<string, unknown> = {
    project: displayWorkspacePath(cwd, root),
    state: integrated && runtimePresent ? "integrated" : "not integrated",
    cli: engineVersion,
    ...(mode === undefined ? {} : { mode }),
    ...(contentDirectory === undefined ? {} : {
      content: displayWorkspacePath(root, contentDirectory)
    })
  };
  let message = integrated && runtimePresent
    ? "Scribe is integrated here."
    : "Scribe is not integrated here.";
  try {
    const context = await detectPackageManagerContext(root);
    const alignment = await checkPackageAlignment(root, engineVersion, context.packageManagerRoot);
    values.packageManager = context.manager;
    values.packages = alignment.aligned
      ? `${engineVersion} (aligned)`
      : alignment.installed.map((entry) =>
        `${entry.packageName}@${entry.status === "resolved" ? entry.version ?? "unknown" : entry.status}`
      );
  } catch (error) {
    values.packages = `inspection failed: ${errorMessage(error)}`;
  }
  const launcherVersion = optionalString(process.env.SCRIBE_LAUNCHER_VERSION);
  if (launcherVersion !== undefined && launcherVersion !== engineVersion) {
    values.launcher = launcherVersion;
    message += ` Launcher ${launcherVersion} delegated to project-local CLI ${engineVersion}; this command uses ${engineVersion}.`;
  }
  values.create = "scribe studio init";
  values.open = "scribe studio <article>";
  values.check = "scribe validate <article>";
  values.next = integrated && runtimePresent ? "scribe update" : "scribe integrate --dry-run";
  return { title: "Project status", message, values };
}

async function firstExistingContentDirectory(root: string): Promise<string | undefined> {
  for (const candidate of contentConventions) {
    const path = resolve(root, candidate);
    try {
      await access(path);
      return path;
    } catch {
      // Continue through the documented content-directory conventions.
    }
  }
  return undefined;
}

async function createPlan(method: string, paramsInput: unknown): Promise<unknown> {
  const params = record(paramsInput);
  let apply: (operationId: string) => Promise<unknown>;
  let summary: PlanSummary;
  if (method === "studioArticle.plan") {
    const options = record(params.options);
    const title = requiredString(options.title, "title");
    const slug = optionalString(options.slug);
    const contentDirectory = optionalString(options.contentDirectory);
    const path = optionalString(options.path);
    const root = await findSupportedProjectRoot(cwd) ?? cwd;
    const article = await planStudioArticle(root, {
      title,
      ...(slug === undefined ? {} : { slug }),
      ...(contentDirectory === undefined ? {} : { contentDirectory }),
      ...(path === undefined ? {} : { path })
    });
    apply = async (operationId) => {
      emitEvent(operationId, "task.started", { task: "Create article" });
      await createStudioArticle(article);
      emitEvent(operationId, "task.completed", { task: "Create article" });
      return runStudioSession(article.targetPath, options, operationId);
    };
    summary = {
      root: article.root,
      packages: [],
      commands: [],
      files: [{ path: displayWorkspacePath(article.root, article.targetPath), action: "create" }],
      warnings: [],
      manualSteps: [],
      values: {
        title: article.title,
        slug: article.slug,
        contentDirectory: displayWorkspacePath(article.root, article.contentDirectory),
        targetPath: displayWorkspacePath(article.root, article.targetPath)
      }
    };
  } else {
    ({ apply, summary } = await domainPlan(method, params));
  }
  const planId = randomUUID();
  plans.set(planId, { method, apply, summary });
  return { planId, summary };
}

async function domainPlan(
  method: string,
  params: Readonly<Record<string, unknown>>
): Promise<{
  readonly apply: (operationId: string) => Promise<unknown>;
  readonly summary: PlanSummary;
}> {
  if (method === "init.plan") {
    const contentDirectory = optionalString(params.contentDirectory);
    const plan = await planInit(cwd, {
      ...(contentDirectory === undefined ? {} : { contentDirectory }),
      withAssets: params.withAssets === true
    });
    return {
      apply: async (operationId) => {
        emitEvent(operationId, "task.started", { task: "Create content directories" });
        await applyInitPlan(plan);
        emitEvent(operationId, "task.completed", { task: "Create content directories" });
        return {
          title: "Scribe content launchpad ready",
          values: {
            contentDirectory: displayWorkspacePath(plan.root, plan.contentDirectory),
            ...(plan.assetDirectory === undefined ? {} : {
              assetDirectory: displayWorkspacePath(plan.root, plan.assetDirectory)
            })
          }
        };
      },
      summary: {
        root: plan.root,
        packages: [],
        commands: [],
        files: plan.directories.map((path) => ({
          path: displayWorkspacePath(plan.root, path),
          action: "create directory"
        })),
        warnings: [],
        manualSteps: [],
        values: {
          contentDirectory: displayWorkspacePath(plan.root, plan.contentDirectory),
          ...(plan.assetDirectory === undefined ? {} : {
            assetDirectory: displayWorkspacePath(plan.root, plan.assetDirectory)
          })
        }
      }
    };
  }
  if (method === "integrate.plan") {
    const plan = await planIntegrate(cwd, styleMode(params.mode), engineVersion);
    return {
      apply: async (operationId) => {
        try {
          const result = await applyIntegratePlan(plan, engineVersion, {
            onEvent: (event) => emitEvent(operationId, event.type, {
              task: event.task,
              ...(event.detail === undefined ? {} : { detail: event.detail })
            })
          });
          if (result.manualSteps.length > 0) {
            throw rpcFailure(
              -32_604,
              "Scribe completed the safe automated integration, but manual actions remain.",
              "manual-action",
              result.manualSteps,
              true
            );
          }
          return {
            title: "Scribe integrated",
            values: { installedPackages: result.installedPackages }
          };
        } catch (error) {
          if (error instanceof IntegrateOperationError) {
            throw rpcFailure(
              error.conflict ? -32_602 : -32_603,
              error.message,
              error.conflict ? "conflict" : "operation",
              error.recovery,
              error.partialState
            );
          }
          throw error;
        }
      },
      summary: {
        root: plan.inspection.root,
        ...(plan.mode === undefined ? {} : { mode: plan.mode }),
        packages: plan.packages.map((entry) => ({
          name: entry.name,
          target: entry.version,
          placement: entry.development ? "development" : "runtime"
        })),
        commands: plan.commands.map((command) => ({
          label: "Install aligned Scribe packages",
          command: formatPackageCommand(command)
        })),
        files: plan.changes.map((change) => ({
          path: change.path,
          action: change.new ? "create" : "update"
        })),
        warnings: [...plan.ambiguities, ...plan.warnings],
        manualSteps: plan.manualSteps,
        values: { reason: plan.reason }
      }
    };
  }
  if (method === "medium.plan") {
    const into = optionalString(params.into);
    const plan = await planMediumImport(cwd, requiredString(params.archive, "archive"), {
      ...(into === undefined ? {} : { into }),
      includeDrafts: params.includeDrafts === true,
      includeResponses: params.includeResponses === true,
      downloadAssets: params.noDownloadAssets !== true
    });
    return {
      apply: async (operationId) => {
        emitEvent(operationId, "task.started", { task: "Import Medium articles" });
        const result = await applyMediumImportPlan(plan);
        for (const warning of result.warnings) {
          emitEvent(operationId, "warning", {
            task: warning.code,
            detail: warning.message
          });
        }
        emitEvent(operationId, "task.completed", { task: "Import Medium articles" });
        return {
          title: "Medium import completed",
          values: {
            articles: result.articles,
            createdFiles: result.createdFiles.length,
            warnings: result.warnings.length
          }
        };
      },
      summary: {
        root: plan.root,
        packages: [],
        commands: [],
        files: plan.articles.map((article) => ({
          path: displayWorkspacePath(plan.root, article.targetPath),
          action: "create"
        })),
        warnings: [],
        manualSteps: [],
        values: {
          archive: displayWorkspacePath(plan.root, plan.archivePath),
          contentDirectory: displayWorkspacePath(plan.root, plan.contentDirectory),
          articles: plan.articles.length,
          skippedDrafts: plan.skippedDrafts,
          skippedResponses: plan.skippedResponseCandidates
        }
      }
    };
  }
  if (method === "update.plan") {
    let plan;
    try {
      plan = await planScribeUpdate(cwd, engineVersion);
    } catch (error) {
      if (error instanceof UpdateOperationError) {
        throw rpcFailure(
          error.usage ? -32_602 : -32_603,
          error.message,
          error.usage ? "usage" : "operation",
          error.recovery,
          error.partialState
        );
      }
      throw error;
    }
    return {
      apply: async (operationId) => {
        try {
          const result = await applyScribeUpdatePlan(plan, {
            onEvent: (event) => emitEvent(operationId, event.type, {
              task: event.task,
              ...(event.detail === undefined ? {} : { detail: event.detail })
            })
          });
          return {
            title: result.changed ? "Scribe updated" : "Scribe is already current",
            values: { target: result.target, changed: result.changed }
          };
        } catch (error) {
          if (error instanceof UpdateOperationError) {
            throw rpcFailure(
              error.usage ? -32_602 : -32_603,
              error.message,
              error.usage ? "usage" : "operation",
              error.recovery,
              error.partialState
            );
          }
          throw error;
        }
      },
      summary: {
        root: plan.projectRoot,
        packages: plan.before.installed.map((entry) => ({
          name: entry.packageName,
          ...(entry.version === undefined ? {} : { current: entry.version }),
          target: plan.target
        })),
        commands: plan.commands.map((command) => ({
          label: "Align Scribe packages",
          command: formatPackageCommand(command)
        })),
        files: [],
        warnings: [],
        manualSteps: [],
        values: {
          packageManager: plan.context.manager,
          target: plan.target,
          aligned: plan.before.aligned
        }
      }
    };
  }
  throw rpcFailure(-32_601, `Unknown planning method ${JSON.stringify(method)}.`, "usage");
}

async function applyPlan(method: string, paramsInput: unknown): Promise<unknown> {
  const params = record(paramsInput);
  const planId = requiredString(params.planId, "planId");
  const plan = plans.get(planId);
  if (plan === undefined || method !== `${plan.method.slice(0, -5)}.apply`) {
    throw rpcFailure(-32_602, "The plan is missing, expired, or belongs to another operation.", "usage");
  }
  plans.delete(planId);
  return plan.apply(nextOperationId(method.slice(0, -6)));
}

async function runStudioSession(
  article: string,
  params: Readonly<Record<string, unknown>>,
  operationId: string
): Promise<unknown> {
  const explicitMode = styleMode(params.mode);
  let mode: StyleMode;
  let modeReason: string;
  if (explicitMode !== undefined) {
    mode = explicitMode;
    modeReason = `Selected explicitly with --mode ${mode}.`;
  } else {
    const resolution = await resolveProjectStyleMode(cwd);
    if (resolution.mode === undefined || resolution.ambiguities.length > 0) {
      throw rpcFailure(
        -32_602,
        resolution.ambiguities.join("\n") || "Scribe could not determine the Studio style mode.",
        "usage"
      );
    }
    mode = resolution.mode;
    modeReason = resolution.reason;
  }
  const port = resolveStudioPort(params.port);
  const hostCss = optionalString(params.hostCss);
  emitEvent(operationId, "task.started", { task: "Start Studio" });
  const handle = await startStudio({
    root: cwd,
    path: article,
    mode,
    modeReason,
    port,
    strictPort: params.port !== undefined && params.port !== null,
    open: params.noOpen !== true,
    ...(hostCss === undefined ? {} : { hostCss })
  });
  emitEvent(operationId, "task.completed", {
    task: "Studio ready",
    detail: handle.origin
  });
  try {
    await waitForTerminationSignal();
    if (handle.hasUnsavedChanges()) {
      emitEvent(operationId, "warning", {
        task: "Unsaved draft preserved",
        detail: "Studio recovery will offer it when this article is reopened."
      });
    }
  } finally {
    await handle.close();
  }
  return {
    title: "Scribe Studio stopped",
    values: {
      source: displayWorkspacePath(cwd, resolve(cwd, article)),
      mode,
      origin: handle.origin
    }
  };
}

function waitForTerminationSignal(): Promise<void> {
  return new Promise((resolveStop) => {
    const stop = () => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      resolveStop();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function requiredPort(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw rpcFailure(-32_602, "port must be an integer from 1 to 65535.", "usage");
  }
  return value;
}

export function resolveStudioPort(port: unknown): number {
  if (port === undefined || port === null) return 4317;
  return requiredPort(port);
}



function parseRequest(line: string): RpcRequest {
  const request = record(JSON.parse(line) as unknown);
  if (request.jsonrpc !== "2.0") throw new Error("Only JSON-RPC 2.0 is supported.");
  if (typeof request.id !== "number" || !Number.isSafeInteger(request.id) || request.id < 0) {
    throw new Error("Request id must be a non-negative integer.");
  }
  if (typeof request.method !== "string" || request.method === "") {
    throw new Error("Request method must be a non-empty string.");
  }
  return {
    jsonrpc: "2.0",
    id: request.id,
    method: request.method,
    ...("params" in request ? { params: request.params } : {})
  };
}

function writeMessage(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function writeError(
  id: number | null,
  code: number,
  message: string,
  kind: string,
  recovery: readonly string[] = [],
  partialState = false
): void {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: { code, message, data: { kind, recovery, partialState } }
  });
}

function emitEvent(
  operationId: string,
  type: string,
  params: Readonly<Record<string, unknown>> = {}
): void {
  writeMessage({
    jsonrpc: "2.0",
    method: "scribe/event",
    params: { operationId, type, ...params }
  });
}
function readPackageVersion(): string {
  const manifest = record(JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as unknown);
  return requiredString(manifest.version, "package version");
}


function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw rpcFailure(-32_602, "Expected an object of method parameters.", "usage");
  }
  return Object.fromEntries(Object.entries(value));
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw rpcFailure(-32_602, `${name} must be a non-empty string.`, "usage");
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
function styleMode(value: unknown): "foundation" | "default" | "tailwind" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "foundation" || value === "default" || value === "tailwind") return value;
  throw rpcFailure(-32_602, "mode must be foundation, default, or tailwind.", "usage");
}


function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw rpcFailure(-32_602, `${name} must be an integer.`, "usage");
  }
  return value;
}

function formatDiagnostic(path: string, value: unknown): string {
  const diagnostic = value !== null && typeof value === "object"
    ? value as {
        readonly line?: number;
        readonly column?: number;
        readonly ruleId?: string;
        readonly source?: string;
        readonly message?: string;
        readonly reason?: string;
      }
    : {};
  const position = diagnostic.line === undefined
    ? path
    : `${path}:${diagnostic.line}:${diagnostic.column ?? 1}`;
  const code = diagnostic.ruleId ?? diagnostic.source;
  const message = diagnostic.message ?? diagnostic.reason ?? String(value);
  return `${position}${code === undefined ? "" : ` [${code}]`} ${message}`;
}


function nextOperationId(prefix: string): string {
  operationSequence += 1;
  return `${prefix}-${operationSequence}`;
}

function completionTitle(method: string): string {
  if (method === "studioArticle.apply") return "Article created";
  if (method === "update.apply") return "Scribe updated";
  if (method === "integrate.apply") return "Scribe integrated";
  if (method === "medium.apply") return "Medium import completed";
  return "Scribe content launchpad ready";
}

interface EngineFailure extends Error {
  readonly code: number;
  readonly kind: string;
  readonly recovery: readonly string[];
  readonly partialState: boolean;
}

function rpcFailure(
  code: number,
  message: string,
  kind: string,
  recovery: readonly string[] = [],
  partialState = false
): EngineFailure {
  return Object.assign(new Error(message), { code, kind, recovery, partialState });
}

function protocolFailure(message: string): EngineFailure {
  return rpcFailure(-32_600, message, "protocol");
}

function normalizeFailure(error: unknown): EngineFailure {
  if (error instanceof Error && "code" in error && "kind" in error) return error as EngineFailure;
  const ruleId = error instanceof Error ? (error as { ruleId?: unknown }).ruleId : undefined;
  const detail = typeof ruleId === "string" && ruleId !== ""
    ? `${ruleId}: ${errorMessage(error)}`
    : errorMessage(error);
  return rpcFailure(-32_603, detail, "internal");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv.includes("--engine")) {
  void runEngine().catch((error: unknown) => {
    process.stderr.write(`Scribe engine failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
