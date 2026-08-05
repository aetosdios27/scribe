import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { suggestClosest } from "./cli-output.js";
import { integrateHelp } from "./command-help.js";
import { detectPackageManager, installCommand, isSupportedPackageManager, type PackageManager } from "./package-manager.js";
import {
  acquireIntegrationLock,
  applyFileChanges,
  FileTransactionError,
  manifestAndLockfilePaths,
  releaseIntegrationLock,
  restoreSnapshot,
  snapshotFiles,
  verifyIntegration,
  type AppliedChange,
  type SnapshotEntry
} from "./transaction.js";
import { checkPackageAlignment, formatAlignmentDiagnostic } from "./version-alignment.js";

export type StyleMode = "foundation" | "default" | "tailwind";
export type { PackageManager };

export interface ProjectInspection {
  readonly root: string;
  readonly packageManager: PackageManager;
  readonly reactVersion?: string;
  readonly hasNext: boolean;
  readonly hasVite: boolean;
  readonly tailwindMajor?: 3 | 4;
  readonly hasTypographyPlugin: boolean;
  readonly hasProseUsage: boolean;
  readonly hasEstablishedTypography: boolean;
  readonly hasNextMdx: boolean;
  readonly hasNextMdxRemote: boolean;
  readonly hasScribeCompiler: boolean;
  readonly hasScribeComponents: boolean;
  readonly hasSyntaxHighlighter: boolean;
  readonly globalStyle?: string;
  readonly packageNames: ReadonlySet<string>;
}

export interface PackageChange {
  readonly name: string;
  readonly version: string;
  readonly development: boolean;
}

interface FileChange {
  readonly path: string;
  readonly description: string;
  readonly content: string;
  readonly new: boolean;
}

export interface IntegratePlan {
  readonly inspection: ProjectInspection;
  readonly mode?: StyleMode;
  readonly reason: string;
  readonly ambiguities: readonly string[];
  readonly packages: readonly PackageChange[];
  readonly commands: readonly (readonly string[])[];
  readonly changes: readonly FileChange[];
  readonly warnings: readonly string[];
  readonly manualSteps: readonly string[];
}

export interface StyleModeResolution {
  readonly inspection: ProjectInspection;
  readonly mode?: StyleMode;
  readonly reason: string;
  readonly ambiguities: readonly string[];
}

export interface IntegrateDependencies {
  readonly cwd?: string;
  readonly version: string;
  readonly stdout?: (value: string) => void;
  readonly stderr?: (value: string) => void;
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly runCommand?: (command: readonly string[], cwd: string) => Promise<number>;
}

const modes = new Set<StyleMode>(["foundation", "default", "tailwind"]);
const ignoredDirectories = new Set([".git", ".next", "dist", "node_modules", "out", "coverage", "test-results"]);
const sourceExtensions = /\.(?:css|js|jsx|mjs|cjs|ts|tsx|md|mdx)$/u;
const styleCandidates = [
  "src/app/globals.css",
  "app/globals.css",
  "src/styles/globals.css",
  "styles/globals.css",
  "src/index.css",
  "src/main.css",
  "index.css"
];
const scribePackages = ["@scribe-sdk/react", "@scribe-sdk/styles", "@scribe-sdk/mdx", "@scribe-sdk/cli"] as const;

export async function inspectProject(inputRoot: string): Promise<ProjectInspection> {
  const root = resolve(inputRoot);
  const manifestPath = resolve(root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    readonly packageManager?: string;
    readonly dependencies?: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
  };
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  const packageNames = new Set(Object.keys(dependencies));
  const files = await collectSourceFiles(root);
  const entries = await mapWithConcurrency(files, 32, async (path) => [path, await readFile(path, "utf8")] as const);
  const source = entries.map(([, value]) => value).join("\n");
  const css = entries.filter(([path]) => path.endsWith(".css")).map(([, value]) => value).join("\n");
  const tailwindMajor = parseTailwindMajor(dependencies.tailwindcss);
  const globalStyle = await firstExisting(root, styleCandidates);

  return {
    root,
    packageManager: await detectPackageManager(root, manifest.packageManager),
    ...(dependencies.react === undefined ? {} : { reactVersion: dependencies.react }),
    hasNext: packageNames.has("next"),
    hasVite: packageNames.has("vite"),
    ...(tailwindMajor === undefined ? {} : { tailwindMajor }),
    hasTypographyPlugin: packageNames.has("@tailwindcss/typography") || /@plugin\s+["']@tailwindcss\/typography["']/u.test(css),
    hasProseUsage: /(?:className|class)\s*=\s*(?:["'][^"']*\bprose\b|\{[^}]*["'][^"']*\bprose\b)/u.test(source),
    hasEstablishedTypography: /(?:\.prose|\.article|\.post(?:-content)?|article)\s*(?:[,{:]|\.[\w-]+\s*\{)[\s\S]{0,400}(?:font-family|font-size|line-height|max-width|inline-size)/u.test(css),
    hasNextMdx: packageNames.has("@next/mdx"),
    hasNextMdxRemote: packageNames.has("next-mdx-remote") || /next-mdx-remote\/rsc/u.test(source),
    hasScribeCompiler: /createScribe(?:Next|Remote)?MdxOptions/u.test(source),
    hasScribeComponents: /createScribeComponents/u.test(source),
    hasSyntaxHighlighter: /(?:shiki|rehype-pretty-code|prism|highlight\.js|rehype-highlight)/iu.test(source),
    ...(globalStyle === undefined ? {} : { globalStyle }),
    packageNames
  };
}

export async function planIntegrate(root: string, explicitMode: StyleMode | undefined, version: string): Promise<IntegratePlan> {
  let inspection: ProjectInspection;
  try {
    inspection = await inspectProject(root);
  } catch (error) {
    throw new Error(`Could not inspect ${resolve(root)}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const { mode, reason, ambiguities } = recommendStyleMode(inspection, explicitMode);

  const packages: PackageChange[] = [];
  const missingRuntime = scribePackages.slice(0, 3).filter((name) => !inspection.packageNames.has(name));
  for (const name of missingRuntime) packages.push({ name, version, development: false });
  const cliMissing = !inspection.packageNames.has("@scribe-sdk/cli");
  if (cliMissing) packages.push({ name: "@scribe-sdk/cli", version, development: true });

  const manager = inspection.packageManager;
  const supported = isSupportedPackageManager(manager);
  const commands: string[][] = [];
  if (supported) {
    if (missingRuntime.length > 0) commands.push(installCommand(manager, missingRuntime.map((name) => `${name}@${version}`), false));
    if (cliMissing) commands.push(installCommand(manager, [`@scribe-sdk/cli@${version}`], true));
  }

  const changes: FileChange[] = [];
  const warnings: string[] = [];
  const manualSteps: string[] = [];
  if (mode !== undefined) {
    const importLine = `@import "@scribe-sdk/styles/${mode}.css";`;
    if (inspection.globalStyle === undefined) {
      manualSteps.push(`Import ${JSON.stringify(`@scribe-sdk/styles/${mode}.css`)} once from the host application's global stylesheet.`);
    } else {
      const existing = await readFile(inspection.globalStyle, "utf8");
      const scribeImport = existing.match(/@scribe-sdk\/styles\/(foundation|default|tailwind)\.css/u)?.[1];
      if (scribeImport !== undefined && scribeImport !== mode) {
        manualSteps.push(`Replace the existing ${scribeImport}.css import in ${displayPath(inspection.root, inspection.globalStyle)} only after reviewing the visual change to ${mode} mode.`);
      } else if (scribeImport === undefined) {
        changes.push({
          path: inspection.globalStyle,
          description: `Add the ${mode} stylesheet import`,
          content: insertCssImport(existing, importLine),
          new: false
        });
      }
    }
  }

  const componentMap = inspection.hasNext
    ? (await firstExisting(inspection.root, ["mdx-components.tsx", "src/mdx-components.tsx"]))
    : undefined;
  if (inspection.hasNextMdx && !inspection.hasScribeComponents && componentMap === undefined) {
    changes.push({
      path: resolve(inspection.root, "mdx-components.tsx"),
      description: "Create the Next.js MDX component map",
      content: `import { createScribeComponents, type ScribeComponents } from "@scribe-sdk/react";\n\nexport function useMDXComponents(components: ScribeComponents): ScribeComponents {\n  return createScribeComponents({ components });\n}\n`,
      new: true
    });
  } else if (!inspection.hasScribeComponents) {
    manualSteps.push("Connect createScribeComponents() at the host's existing MDX render boundary; preserve all current component overrides.");
  }

  if (!inspection.hasScribeCompiler) {
    if (inspection.hasNextMdxRemote) {
      manualSteps.push("Use createScribeRemoteMdxOptions() from @scribe-sdk/mdx/next-remote in the existing MDXRemote options prop.");
    } else if (inspection.hasNextMdx) {
      manualSteps.push("Merge createScribeNextMdxOptions() into the existing @next/mdx loader options without replacing unrelated remark or rehype plugins.");
    } else {
      manualSteps.push("Merge createScribeMdxOptions() into the existing Vite MDX plugin; keep one compilation pipeline and preserve current plugins.");
    }
  }

  if (!supported && packages.length > 0) {
    warnings.push(`Package installation is not automated for ${inspection.packageManager}; integrate will not run package-manager commands.`);
    manualSteps.push(`Install the reported packages manually with ${inspection.packageManager}: ${packages.map((entry) => `${entry.name}@${entry.version}`).join(" ")}`);
  }
  if (inspection.hasSyntaxHighlighter) {
    warnings.push("An existing syntax highlighter was detected. Review the overlap manually; integrate will not remove or replace it.");
  }

  const allDeclared = scribePackages.every((name) => inspection.packageNames.has(name));
  if (allDeclared && await pathExists(resolve(inspection.root, "node_modules"))) {
    const alignment = await checkPackageAlignment(inspection.root, version);
    if (!alignment.aligned) warnings.push(formatAlignmentDiagnostic(alignment, inspection.packageManager));
  }

  return { inspection, ...(mode === undefined ? {} : { mode }), reason, ambiguities, packages, commands, changes, warnings, manualSteps };
}

export async function resolveProjectStyleMode(
  root: string,
  explicitMode?: StyleMode
): Promise<StyleModeResolution> {
  const inspection = await inspectProject(root);
  if (explicitMode !== undefined) {
    return {
      inspection,
      mode: explicitMode,
      reason: `Selected explicitly with --mode ${explicitMode}.`,
      ambiguities: []
    };
  }
  const recommendation = recommendStyleMode(inspection, explicitMode);
  return { inspection, ...recommendation };
}

export function recommendStyleMode(
  inspection: ProjectInspection,
  explicitMode?: StyleMode
): Omit<StyleModeResolution, "inspection"> {
  const ambiguities: string[] = [];
  let mode = explicitMode;
  let reason = explicitMode === undefined ? "" : `Selected explicitly with --mode ${explicitMode}.`;

  if (inspection.reactVersion === undefined || (!inspection.hasNext && !inspection.hasVite)) {
    ambiguities.push("Scribe project detection supports React projects using Next.js or Vite; run the command from that project root.");
  } else if (mode === undefined && inspection.tailwindMajor !== undefined && (inspection.hasTypographyPlugin || inspection.hasProseUsage)) {
    mode = "tailwind";
    reason = `Tailwind ${inspection.tailwindMajor} with an existing prose contract was detected.`;
  } else if (mode === undefined && inspection.tailwindMajor !== undefined) {
    ambiguities.push("Tailwind is installed, but no Typography or .prose contract was found. Choose --mode foundation, default, or tailwind explicitly.");
  } else if (mode === undefined && (inspection.hasEstablishedTypography || inspection.hasProseUsage)) {
    mode = "foundation";
    reason = "Existing article typography and density rules were detected.";
  } else if (mode === undefined) {
    mode = "default";
    reason = "No established article typography was detected.";
  }

  if (inspection.hasNext && inspection.hasVite) {
    ambiguities.push("Both Next.js and Vite were detected. Run the command from the intended application root or pass --mode after confirming the integration boundary.");
  }

  return { ...(mode === undefined ? {} : { mode }), reason, ambiguities };
}

export async function runIntegrate(args: readonly string[], dependencies: IntegrateDependencies): Promise<number> {
  const stdout = dependencies.stdout ?? ((value) => process.stdout.write(value));
  const stderr = dependencies.stderr ?? ((value) => process.stderr.write(value));
  const parsed = parseIntegrateArguments(args);
  if (typeof parsed === "string") {
    stderr(`${parsed}\n${integrateHelp}`);
    return 2;
  }
  if (parsed.help) {
    stdout(integrateHelp);
    return 0;
  }

  let plan: IntegratePlan;
  try {
    plan = await planIntegrate(dependencies.cwd ?? process.cwd(), parsed.mode, dependencies.version);
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  stdout(formatIntegratePlan(plan, parsed.dryRun));
  if (plan.ambiguities.length > 0 || plan.mode === undefined) return 2;
  if (parsed.dryRun) return 0;

  let confirmed: boolean | null;
  if (parsed.yes) confirmed = true;
  else if (dependencies.confirm !== undefined) confirmed = await dependencies.confirm("Apply this Scribe integration plan?");
  else confirmed = await confirmInteractively("Apply this Scribe integration plan?");
  if (confirmed === null) {
    stderr(`This project uses ${plan.inspection.packageManager} and the terminal is non-interactive.\nRe-run with \`--yes\` to apply the reviewed plan without a prompt.\n`);
    return 2;
  }
  if (confirmed === false) {
    stdout("Cancelled. No changes made.\n");
    return 0;
  }

  const projectRoot = plan.inspection.root;
  const manager = plan.inspection.packageManager;
  const supported = isSupportedPackageManager(manager);
  const installedSomething = plan.commands.length > 0;
  const runCommand = dependencies.runCommand ?? spawnCommand;

  let lockPath: string;
  try {
    lockPath = await acquireIntegrationLock(projectRoot);
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  let snapshot: Map<string, SnapshotEntry>;
  try {
    snapshot = await snapshotFiles(projectRoot, [
      ...(supported ? manifestAndLockfilePaths(projectRoot, manager) : []),
      ...plan.changes.map((change) => change.path)
    ]);
  } catch (error) {
    await releaseIntegrationLock(lockPath);
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  let applied: readonly AppliedChange[] = [];
  try {
    for (const command of plan.commands) {
      const status = await runCommand(command, projectRoot);
      if (status !== 0) throw new Error(`Command failed with status ${status}: ${command.join(" ")}`);
    }
    applied = await applyFileChanges(projectRoot, plan.changes);
    const problems = await verifyIntegration(projectRoot, {
      ...(installedSomething ? { packages: plan.packages, stylesheetMode: plan.mode } : {}),
      files: applied.map((change) => ({ path: change.path, created: change.created }))
    });
    if (problems.length > 0) throw new Error(problems.join("\n"));
  } catch (error) {
    const created = error instanceof FileTransactionError
      ? error.written.filter((change) => change.created).map((change) => change.path)
      : applied.filter((change) => change.created).map((change) => change.path);
    const failures = await restoreSnapshot(projectRoot, snapshot, created);
    await releaseIntegrationLock(lockPath);
    stderr(failureMessage(error, failures, projectRoot));
    return 1;
  }

  await releaseIntegrationLock(lockPath);
  stdout(successMessage(plan, installedSomething));
  return 0;
}

function parseIntegrateArguments(args: readonly string[]): { readonly dryRun: boolean; readonly yes: boolean; readonly help: boolean; readonly mode?: StyleMode } | string {
  let mode: StyleMode | undefined;
  let dryRun = false;
  let yes = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") dryRun = true;
    else if (argument === "--yes") yes = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--mode") {
      const value = args[index + 1];
      if (value === undefined || !modes.has(value as StyleMode)) return `Invalid --mode value "${String(value)}". Expected one of: foundation, default, tailwind.`;
      mode = value as StyleMode;
      index += 1;
    } else if (argument?.startsWith("--mode=")) {
      const value = argument.slice("--mode=".length);
      if (!modes.has(value as StyleMode)) return `Invalid --mode value "${value}". Expected one of: foundation, default, tailwind.`;
      mode = value as StyleMode;
    } else {
      const value = String(argument);
      const suggestion = suggestClosest(value, ["--dry-run", "--mode", "--yes", "--help"]);
      return `Unknown integrate option "${value}".${suggestion === undefined ? "" : ` Did you mean "${suggestion}"?`}`;
    }
  }
  return { dryRun, yes, help, ...(mode === undefined ? {} : { mode }) };
}

function formatIntegratePlan(plan: IntegratePlan, dryRun: boolean): string {
  const detected = [
    `React ${plan.inspection.reactVersion ?? "not detected"}`,
    plan.inspection.hasNext ? "Next.js" : undefined,
    plan.inspection.hasVite ? "Vite" : undefined,
    plan.inspection.tailwindMajor === undefined ? undefined : `Tailwind ${plan.inspection.tailwindMajor}`,
    plan.inspection.hasTypographyPlugin ? "Tailwind Typography" : undefined,
    plan.inspection.hasNextMdxRemote ? "next-mdx-remote/rsc" : undefined,
    plan.inspection.hasNextMdx ? "@next/mdx" : undefined
  ].filter(Boolean).join(", ");
  const lines = [
    `Scribe integrate — ${dryRun ? "dry run" : "reviewed plan"}`,
    dryRun ? "No files or packages will be changed." : "Review this plan before confirming changes.",
    "",
    "Detected",
    "  Project          .",
    `  Stack            ${detected}`,
    `  Package manager  ${plan.inspection.packageManager}`,
    "",
    "Recommendation",
    `  Mode    ${plan.mode ?? "unresolved"}`,
    ...(plan.reason === "" ? [] : [`  Reason  ${plan.reason}`]),
    "",
    "Commands",
    ...(plan.commands.length === 0 ? ["  none"] : plan.commands.map((command) => `  ${command.join(" ")}`)),
    "",
    "Packages",
    ...(plan.packages.length === 0 ? ["  none"] : packageLines(plan.packages)),
    "",
    "File changes",
    ...(plan.changes.length === 0 ? ["  none"] : plan.changes.map((change) => `  ${change.new ? "+" : "~"} ${displayPath(plan.inspection.root, change.path)} — ${change.description}`)),
    "",
    "Warnings",
    ...(plan.warnings.length === 0 ? ["  none"] : plan.warnings.flatMap((warning) => warning.split("\n").map((line) => `  ${line}`))),
    "",
    "Manual steps",
    ...(plan.manualSteps.length === 0 ? ["  none"] : plan.manualSteps.map((step) => `  ${step}`))
  ];
  if (plan.ambiguities.length > 0) lines.push("", "Ambiguities", ...plan.ambiguities.map((value) => `  ${value}`));
  lines.push(
    "",
    "Next",
    plan.ambiguities.length > 0 || plan.mode === undefined
      ? "  Resolve the ambiguities above, then rerun `scribe integrate --dry-run`."
      : dryRun
        ? "  Review this plan, then run `scribe integrate` to confirm and apply it."
        : "  Confirm only after the detected stack and proposed changes are correct."
  );
  return `${lines.join("\n")}\n`;
}

function packageLines(packages: readonly PackageChange[]): string[] {
  const dependencies = packages.filter((entry) => !entry.development);
  const development = packages.filter((entry) => entry.development);
  const lines: string[] = [];
  if (dependencies.length > 0) lines.push("  dependencies", ...dependencies.map((entry) => `    + ${entry.name}@${entry.version}`));
  if (development.length > 0) lines.push("  devDependencies", ...development.map((entry) => `    + ${entry.name}@${entry.version}`));
  return lines;
}

function failureMessage(error: unknown, failures: readonly string[], root: string): string {
  const lines = [
    `Could not complete the Scribe integration: ${error instanceof Error ? error.message : String(error)}`,
    "",
    "Rollback",
    failures.length > 0
      ? `  Could not restore: ${failures.map((path) => displayPath(root, path)).join(", ")}. Review and restore these files manually.`
      : "  Restored the reported manifest, lockfile, and source files to their previous state."
  ];
  return `${lines.join("\n")}\n`;
}

function successMessage(plan: IntegratePlan, installedSomething: boolean): string {
  const lines = [
    "Success  Scribe integrated",
    `  Mode           ${plan.mode}`,
    "",
    "Packages",
    plan.packages.length === 0
      ? "  none"
      : plan.packages.map((entry) => `  + ${entry.name}@${entry.version}${entry.development ? " (dev)" : ""}`).join("\n"),
    "",
    "Changed files",
    plan.changes.length === 0
      ? "  none"
      : plan.changes.map((change) => `  ${change.new ? "+" : "~"} ${displayPath(plan.inspection.root, change.path)}`).join("\n"),
    "",
    "Warnings",
    plan.warnings.length === 0 ? "  none" : plan.warnings.flatMap((warning) => warning.split("\n").map((line) => `  ${line}`)).join("\n"),
    "",
    "Next",
    `  Run \`${verificationCommand(plan.inspection.packageManager)}\`.`,
    "  Roll back by reverting the files above and removing the packages listed above."
  ];
  if (installedSomething) {
    lines.push(
      "",
      "Scribe is installed in this project.",
      "",
      "Daily commands",
      "  scribe studio <article>",
      "  scribe validate <article>",
      "",
      "Run the project-local CLI through your package manager, or install it globally:",
      plan.inspection.packageManager === "bun"
        ? "  bun add --global @scribe-sdk/cli@alpha   # then: scribe <command>"
        : "  npm install --global @scribe-sdk/cli@alpha   # then: scribe <command>"
    );
  }
  return `${lines.join("\n")}\n`;
}

async function collectSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 7 || files.length >= 1_000) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".prose") continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(path, depth + 1);
      } else if (sourceExtensions.test(entry.name)) files.push(path);
    }
  }
  await visit(root, 0);
  return files;
}

async function firstExisting(root: string, candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    const path = resolve(root, candidate);
    try {
      await access(path, constants.F_OK);
      return path;
    } catch {
      // Continue through ordered candidates.
    }
  }
  return undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function verificationCommand(manager: PackageManager): string {
  if (manager === "bun") return "bunx scribe validate path/to/article.mdx";
  if (manager === "pnpm") return "pnpm exec scribe validate path/to/article.mdx";
  if (manager === "yarn") return "yarn scribe validate path/to/article.mdx";
  return "npx --no-install scribe validate path/to/article.mdx";
}

function insertCssImport(existing: string, importLine: string): string {
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const leadingImports = existing.match(/^(?:(?:\uFEFF?@charset[^\r\n]*;\r?\n)?(?:@import[^\r\n]*;\r?\n)+)/u)?.[0];
  if (leadingImports !== undefined) {
    return `${leadingImports}${importLine}${newline}${existing.slice(leadingImports.length)}`;
  }
  return `${importLine}${newline}${newline}${existing}`;
}

function parseTailwindMajor(version: string | undefined): 3 | 4 | undefined {
  if (version === undefined) return undefined;
  const normalized = version.trim().replace(/^[\s<=>~^]*/u, "");
  const match = /^(\d+)(?:\.|$)/u.exec(normalized);
  const major = match === null ? undefined : Number(match[1]);
  return major === 3 || major === 4 ? major : undefined;
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  map: (value: Input) => Promise<Output>
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await map(values[index] as Input);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function displayPath(root: string, path: string): string {
  const value = relative(root, path);
  return value === "" ? "." : value;
}

async function confirmInteractively(question: string): Promise<boolean | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(?:y|yes)$/iu.test((await prompt.question(`${question} [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}

async function spawnCommand(command: readonly string[], cwd: string): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const child = spawn(command[0] as string, command.slice(1), { cwd, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code) => resolveStatus(code ?? 1));
  });
}
