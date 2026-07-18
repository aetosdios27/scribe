import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

export type StyleMode = "foundation" | "default" | "tailwind";
export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

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

interface FileChange {
  readonly path: string;
  readonly description: string;
  readonly content: string;
}

export interface InitPlan {
  readonly inspection: ProjectInspection;
  readonly mode?: StyleMode;
  readonly reason: string;
  readonly ambiguities: readonly string[];
  readonly commands: readonly (readonly string[])[];
  readonly changes: readonly FileChange[];
  readonly manualSteps: readonly string[];
}

export interface StyleModeResolution {
  readonly inspection: ProjectInspection;
  readonly mode?: StyleMode;
  readonly reason: string;
  readonly ambiguities: readonly string[];
}

export interface InitDependencies {
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

export const initHelp = `Initialize Scribe deliberately inside an existing React project.

Usage:
  scb init --dry-run
  scb init [--yes]
  scb init --mode foundation [--yes]
  scb init --mode default [--yes]
  scb init --mode tailwind [--yes]

Options:
  --dry-run       Inspect and print the plan without installing or writing files.
  --mode <mode>   Select foundation, default, or tailwind styling.
  --yes           Apply the reported plan without an interactive confirmation.
  -h, --help      Show this command help.
`;

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
  const entries = await Promise.all(files.map(async (path) => [path, await readFile(path, "utf8")] as const));
  const source = entries.map(([, value]) => value).join("\n");
  const css = entries.filter(([path]) => path.endsWith(".css")).map(([, value]) => value).join("\n");
  const tailwindVersion = dependencies.tailwindcss;
  const tailwindMajor = tailwindVersion?.match(/(?:^|[^\d])([34])(?:\.|$)/u)?.[1];
  const globalStyle = await firstExisting(root, styleCandidates);

  return {
    root,
    packageManager: await detectPackageManager(root, manifest.packageManager),
    ...(dependencies.react === undefined ? {} : { reactVersion: dependencies.react }),
    hasNext: packageNames.has("next"),
    hasVite: packageNames.has("vite"),
    ...(tailwindMajor === "3" || tailwindMajor === "4" ? { tailwindMajor: Number(tailwindMajor) as 3 | 4 } : {}),
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

export async function planInit(root: string, explicitMode: StyleMode | undefined, version: string): Promise<InitPlan> {
  let inspection: ProjectInspection;
  try {
    inspection = await inspectProject(root);
  } catch (error) {
    throw new Error(`Could not inspect ${resolve(root)}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const { mode, reason, ambiguities } = recommendStyleMode(inspection, explicitMode);

  const commands: string[][] = [];
  const missingRuntime = ["@scribe-sdk/react", "@scribe-sdk/styles", "@scribe-sdk/mdx"]
    .filter((name) => !inspection.packageNames.has(name))
    .map((name) => `${name}@${version}`);
  const missingCli = inspection.packageNames.has("@scribe-sdk/cli") ? [] : [`@scribe-sdk/cli@${version}`];
  if (missingRuntime.length > 0) commands.push(installCommand(inspection.packageManager, missingRuntime, false));
  if (missingCli.length > 0) commands.push(installCommand(inspection.packageManager, missingCli, true));

  const changes: FileChange[] = [];
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
          content: insertCssImport(existing, importLine)
        });
      }
    }
  }

  const componentMap = inspection.hasNext
    ? (await firstExisting(inspection.root, ["mdx-components.tsx", "src/mdx-components.tsx"]))
    : undefined;
  if (inspection.hasNextMdx && !inspection.hasScribeComponents && componentMap === undefined) {
    const path = resolve(inspection.root, "mdx-components.tsx");
    changes.push({
      path,
      description: "Create the Next.js MDX component map",
      content: `import { createScribeComponents, type ScribeComponents } from "@scribe-sdk/react";\n\nexport function useMDXComponents(components: ScribeComponents): ScribeComponents {\n  return createScribeComponents({ components });\n}\n`
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
  if (inspection.hasSyntaxHighlighter) {
    manualSteps.push("An existing syntax highlighter was detected. Review the overlap manually; init will not remove or replace it.");
  }

  return { inspection, ...(mode === undefined ? {} : { mode }), reason, ambiguities, commands, changes, manualSteps };
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

export async function runInit(args: readonly string[], dependencies: InitDependencies): Promise<number> {
  const stdout = dependencies.stdout ?? ((value) => process.stdout.write(value));
  const stderr = dependencies.stderr ?? ((value) => process.stderr.write(value));
  const parsed = parseInitArguments(args);
  if (typeof parsed === "string") {
    stderr(`${parsed}\n${initHelp}`);
    return 2;
  }
  if (parsed.help) {
    stdout(initHelp);
    return 0;
  }

  let plan: InitPlan;
  try {
    plan = await planInit(dependencies.cwd ?? process.cwd(), parsed.mode, dependencies.version);
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  stdout(formatPlan(plan, parsed.dryRun));
  if (plan.ambiguities.length > 0 || plan.mode === undefined) return 2;
  if (parsed.dryRun) return 0;

  const confirmed = parsed.yes || await (dependencies.confirm ?? confirmInteractively)("Apply this Scribe initialization plan?");
  if (!confirmed) {
    stdout("No files were changed.\n");
    return 0;
  }

  const runCommand = dependencies.runCommand ?? spawnCommand;
  for (const command of plan.commands) {
    const status = await runCommand(command, plan.inspection.root);
    if (status !== 0) {
      stderr(`Command failed with status ${status}: ${command.join(" ")}\nNo source files were changed.\n`);
      return 1;
    }
  }

  try {
    for (const change of plan.changes) await atomicWrite(change.path, change.content);
  } catch (error) {
    stderr(`Could not apply the reported Scribe changes: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  stdout(`Scribe initialized in ${plan.mode} mode.\nModified: ${plan.changes.length === 0 ? "none" : plan.changes.map((change) => displayPath(plan.inspection.root, change.path)).join(", ")}\nSkipped: existing configuration was preserved.\nVerify with: ${verificationCommand(plan.inspection.packageManager)}\nRollback: revert only the files listed above and remove packages added by the displayed commands.\n`);
  return 0;
}

function parseInitArguments(args: readonly string[]): { readonly dryRun: boolean; readonly yes: boolean; readonly help: boolean; readonly mode?: StyleMode } | string {
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
    } else return `Unknown init option "${String(argument)}".`;
  }
  return { dryRun, yes, help, ...(mode === undefined ? {} : { mode }) };
}

function formatPlan(plan: InitPlan, dryRun: boolean): string {
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
    dryRun ? "Scribe public alpha init dry run — no files or packages will be changed." : "Scribe public alpha initialization plan.",
    `Project: ${plan.inspection.root}`,
    `Detected stack: ${detected}`,
    `Package manager: ${plan.inspection.packageManager}`,
    `Recommended style mode: ${plan.mode ?? "unresolved"}${plan.reason === "" ? "" : ` — ${plan.reason}`}`,
    "Proposed commands:",
    ...(plan.commands.length === 0 ? ["  none"] : plan.commands.map((command) => `  ${command.join(" ")}`)),
    "Proposed file changes:",
    ...(plan.changes.length === 0 ? ["  none"] : plan.changes.map((change) => `  ${displayPath(plan.inspection.root, change.path)} — ${change.description}`)),
    "Manual steps:",
    ...(plan.manualSteps.length === 0 ? ["  none"] : plan.manualSteps.map((step) => `  ${step}`))
  ];
  if (plan.ambiguities.length > 0) lines.push("Unresolved:", ...plan.ambiguities.map((value) => `  ${value}`));
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

async function detectPackageManager(root: string, declaration?: string): Promise<PackageManager> {
  for (const [filename, manager] of [["bun.lock", "bun"], ["bun.lockb", "bun"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["package-lock.json", "npm"]] as const) {
    if (await firstExisting(root, [filename]) !== undefined) return manager;
  }
  const declared = declaration?.split("@")[0];
  return declared === "bun" || declared === "pnpm" || declared === "yarn" || declared === "npm" ? declared : "npm";
}

function installCommand(manager: PackageManager, packages: readonly string[], development: boolean): string[] {
  if (manager === "bun") return ["bun", "add", ...(development ? ["--dev"] : []), ...packages];
  if (manager === "pnpm") return ["pnpm", "add", ...(development ? ["--save-dev"] : []), ...packages];
  if (manager === "yarn") return ["yarn", "add", ...(development ? ["--dev"] : []), ...packages];
  return ["npm", "install", ...(development ? ["--save-dev"] : []), ...packages];
}

function verificationCommand(manager: PackageManager): string {
  if (manager === "bun") return "bunx scb validate path/to/article.mdx";
  if (manager === "pnpm") return "pnpm exec scb validate path/to/article.mdx";
  if (manager === "yarn") return "yarn scb validate path/to/article.mdx";
  return "npx scb validate path/to/article.mdx";
}

function insertCssImport(existing: string, importLine: string): string {
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const leadingImports = existing.match(/^(?:(?:\uFEFF?@charset[^\r\n]*;\r?\n)?(?:@import[^\r\n]*;\r?\n)+)/u)?.[0];
  if (leadingImports !== undefined) {
    return `${leadingImports}${importLine}${newline}${existing.slice(leadingImports.length)}`;
  }
  return `${importLine}${newline}${newline}${existing}`;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = resolve(dirname(path), `.${basename(path)}.scribe-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

function displayPath(root: string, path: string): string {
  const value = relative(root, path);
  return value === "" ? "." : value;
}

async function confirmInteractively(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
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
