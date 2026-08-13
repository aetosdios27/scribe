import { constants } from "node:fs";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";

import { suggestClosest } from "./cli-output.js";
import { integrateHelp } from "./command-help.js";
import {
  detectPackageManagerContext,
  formatPackageCommand,
  isAutomatedPackageManager,
  scribeConvergenceCommands,
  runPackageCommand,
  type PackageCommand,
  type PackageManager,
  type PackageManagerContext
} from "./package-manager.js";
import {
  acquireIntegrationLock,
  applyFileChanges,
  assertExpectedFileStates,
  captureExpectedFileState,
  FileStateConflictError,
  FileTransactionError,
  hashContent,
  manifestAndLockfilePaths,
  mergeAppliedChanges,
  observeTrackedMutations,
  releaseIntegrationLock,
  restoreSnapshot,
  snapshotFiles,
  verifyIntegration,
  type AppliedChange,
  type ExpectedFileState,
  type IntegrationLockHandle,
  type SnapshotEntry
} from "./transaction.js";
import {
  checkPackageAlignment,
  formatAlignmentDiagnostic,
  scribePackageDefinitions,
  type AlignmentReport,
  type InstalledPackageVersion
} from "./version-alignment.js";

export type StyleMode = "foundation" | "default" | "tailwind";
export type { PackageManager };

type Framework = "next" | "vite";

export interface ProjectInspection {
  readonly root: string;
  readonly packageManager?: PackageManager;
  readonly packageManagerRoot?: string;
  readonly packageManagerContext?: PackageManagerContext;
  readonly packageManagerIssue?: string;
  readonly reactVersion?: string;
  readonly hasNext: boolean;
  readonly hasVite: boolean;
  readonly framework?: Framework;
  readonly frameworkReason?: string;
  readonly frameworkAmbiguity?: string;
  readonly tailwindMajor?: 3 | 4;
  readonly hasTypographyPlugin: boolean;
  readonly hasProseUsage: boolean;
  readonly hasEstablishedTypography: boolean;
  readonly hasNextMdx: boolean;
  readonly hasNextMdxRemote: boolean;
  readonly hasViteMdx: boolean;
  readonly hasScribeCompiler: boolean;
  readonly hasScribeComponents: boolean;
  readonly hasSyntaxHighlighter: boolean;
  readonly globalStyle?: string;
  readonly globalStyleCandidates: readonly string[];
  readonly componentMap?: string;
  readonly sourceScanTruncated: boolean;
  readonly packageNames: ReadonlySet<string>;
  readonly packageSpecifiers: ReadonlyMap<string, {
    readonly specifier: string;
    readonly development: boolean;
  }>;
  readonly packagePlacementIssues: readonly string[];
}

export interface PackageChange {
  readonly name: string;
  readonly version: string;
  readonly development: boolean;
}

interface FileChange {
  readonly path: string;
  readonly applicationPath: string;
  readonly description: string;
  readonly content: string;
  readonly expected: ExpectedFileState;
  readonly new: boolean;
}

interface GuardedFile {
  readonly path: string;
  readonly expected: ExpectedFileState;
}

export interface IntegratePlan {
  readonly inspection: ProjectInspection;
  readonly mode?: StyleMode;
  readonly reason: string;
  readonly ambiguities: readonly string[];
  readonly packages: readonly PackageChange[];
  readonly commands: readonly PackageCommand[];
  readonly changes: readonly FileChange[];
  readonly guards: readonly GuardedFile[];
  readonly warnings: readonly string[];
  /**
   * These are required actions, not informational notes. A run that still has
   * manualSteps after its automated portion completes must not report a fully
   * integrated state.
   */
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
  readonly runCommand?: (command: PackageCommand, cwd: string) => Promise<number>;
}

interface SourceEntry {
  readonly path: string;
  readonly relativePath: string;
  readonly content: string;
}

interface SourceCollection {
  readonly entries: readonly SourceEntry[];
  readonly truncated: boolean;
}

const modes = new Set<StyleMode>(["foundation", "default", "tailwind"]);
const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  ".cache",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "test-results",
  "vendor"
]);
const sourceExtensions = /\.(?:css|js|jsx|mjs|cjs|mts|cts|ts|tsx)$/u;
const codeExtensions = /\.(?:js|jsx|mjs|cjs|mts|cts|ts|tsx)$/u;
const styleCandidates = [
  "src/app/globals.css",
  "app/globals.css",
  "src/styles/globals.css",
  "styles/globals.css",
  "src/index.css",
  "src/main.css",
  "index.css"
];
const nextConfigNames = new Set([
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.ts",
  "next.config.mts",
  "next.config.cts"
]);
const viteConfigNames = new Set([
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.cts"
]);

export async function inspectProject(inputRoot: string): Promise<ProjectInspection> {
  const root = await canonicalDirectory(inputRoot);
  const manifestPath = resolve(root, "package.json");

  const manifest = await readManifest(manifestPath);
  const runtimeDependencies = normalizeDependencyRecord(manifest.dependencies, "dependencies", manifestPath);
  const developmentDependencies = normalizeDependencyRecord(manifest.devDependencies, "devDependencies", manifestPath);
  const packagePlacementIssues = scribePackageDefinitions
    .filter((definition) =>
      runtimeDependencies[definition.name] !== undefined &&
      developmentDependencies[definition.name] !== undefined
    )
    .map((definition) =>
      `${definition.name} is declared in both dependencies and devDependencies. Remove the duplicate declaration before Scribe mutates package state.`
    );

  const packageSpecifiers = new Map<string, { specifier: string; development: boolean }>();
  for (const [name, specifier] of Object.entries(runtimeDependencies)) {
    packageSpecifiers.set(name, { specifier, development: false });
  }
  for (const [name, specifier] of Object.entries(developmentDependencies)) {
    packageSpecifiers.set(name, { specifier, development: true });
  }
  const packageNames = new Set(packageSpecifiers.keys());
  const reactPackage = packageSpecifiers.get("react");

  let packageManagerContext: PackageManagerContext | undefined;
  let packageManagerIssue: string | undefined;
  try {
    packageManagerContext = await detectPackageManagerContext(
      root,
      typeof manifest.packageManager === "string" ? manifest.packageManager : undefined
    );
  } catch (error) {
    packageManagerIssue = error instanceof Error ? error.message : String(error);
  }

  const collection = await collectSourceFiles(root);
  const entries = collection.entries;
  const codeEntries = entries.filter((entry) => codeExtensions.test(entry.path));
  const cssEntries = entries.filter((entry) => entry.path.endsWith(".css"));

  const code = codeEntries.map((entry) => entry.content).join("\n");
  const css = cssEntries.map((entry) => entry.content).join("\n");
  const tailwindMajor = parseTailwindMajor(packageSpecifiers.get("tailwindcss")?.specifier);

  const globalStyleCandidates = await existingCandidates(root, styleCandidates);
  const globalStyle = chooseGlobalStyle(root, globalStyleCandidates, codeEntries);

  const componentMap = packageNames.has("next")
    ? await firstExisting(root, ["mdx-components.tsx", "src/mdx-components.tsx"])
    : undefined;

  const nextConfigText = codeEntries
    .filter((entry) => nextConfigNames.has(basename(entry.path)))
    .map((entry) => entry.content)
    .join("\n");
  const viteConfigText = codeEntries
    .filter((entry) => viteConfigNames.has(basename(entry.path)))
    .map((entry) => entry.content)
    .join("\n");

  const hasNext = packageNames.has("next");
  const hasVite = packageNames.has("vite");
  const frameworkResolution = await detectFramework(
    root,
    hasNext,
    hasVite,
    nextConfigText.length > 0,
    viteConfigText.length > 0
  );

  const remoteRendererEntries = codeEntries.filter((entry) =>
    /(?:from\s+["']next-mdx-remote\/rsc["']|import\s*\(\s*["']next-mdx-remote\/rsc["']\s*\))/u.test(entry.content)
  );
  const remoteRendererText = remoteRendererEntries.map((entry) => entry.content).join("\n");

  const hasNextMdx =
    packageNames.has("@next/mdx") &&
    /(?:from\s+["']@next\/mdx["']|require\(\s*["']@next\/mdx["']\s*\)|@next\/mdx)/u.test(nextConfigText);

  const hasNextMdxRemote =
    packageNames.has("next-mdx-remote") &&
    remoteRendererEntries.length > 0;

  const hasViteMdx =
    frameworkResolution.framework === "vite" &&
    /(?:@mdx-js\/rollup|createMdx|mdx\s*\()/iu.test(viteConfigText);

  const componentMapSource = componentMap === undefined
    ? ""
    : await readFile(componentMap, "utf8");

  const hasScribeComponents =
    /createScribeComponents/u.test(componentMapSource) ||
    codeEntries.some((entry) =>
      /(?:import|require)[\s\S]{0,160}@scribe-sdk\/react/u.test(entry.content) &&
      /createScribeComponents/u.test(entry.content)
    );

  const hasScribeCompiler =
    (
      frameworkResolution.framework === "next" &&
      hasNextMdx &&
      /createScribeNextMdxOptions/u.test(nextConfigText)
    ) ||
    (
      frameworkResolution.framework === "next" &&
      hasNextMdxRemote &&
      /createScribeRemoteMdxOptions/u.test(remoteRendererText)
    ) ||
    (
      frameworkResolution.framework === "vite" &&
      hasViteMdx &&
      /createScribeMdxOptions/u.test(viteConfigText)
    );

  return {
    root,
    ...(packageManagerContext === undefined
      ? {}
      : {
          packageManagerContext,
          packageManager: packageManagerContext.manager,
          packageManagerRoot: packageManagerContext.packageManagerRoot
        }),
    ...(packageManagerIssue === undefined
      ? {}
      : { packageManagerIssue }),
    ...(reactPackage === undefined
      ? {}
      : { reactVersion: reactPackage.specifier }),
    hasNext,
    hasVite,
    ...(frameworkResolution.framework === undefined
      ? {}
      : { framework: frameworkResolution.framework }),
    ...(frameworkResolution.reason === undefined
      ? {}
      : { frameworkReason: frameworkResolution.reason }),
    ...(frameworkResolution.ambiguity === undefined
      ? {}
      : { frameworkAmbiguity: frameworkResolution.ambiguity }),
    ...(tailwindMajor === undefined
      ? {}
      : { tailwindMajor }),
    hasTypographyPlugin:
      packageNames.has("@tailwindcss/typography") ||
      /@plugin\s+["']@tailwindcss\/typography["']/u.test(css),
    hasProseUsage: codeEntries.some((entry) =>
      /(?:className|class)\s*=\s*(?:["'][^"']*\bprose\b|\{[^}]{0,240}["'][^"']*\bprose\b)/u.test(
        entry.content
      )
    ),
    hasEstablishedTypography: cssEntries.some((entry) =>
      /(?:\.prose|\.article|\.post(?:-content)?|article)\s*(?:[,{:]|\.[\w-]+\s*\{)[\s\S]{0,400}(?:font-family|font-size|line-height|max-width|inline-size)/u.test(
        entry.content
      )
    ),
    hasNextMdx,
    hasNextMdxRemote,
    hasViteMdx,
    hasScribeCompiler,
    hasScribeComponents,
    hasSyntaxHighlighter:
      [
        "shiki",
        "rehype-pretty-code",
        "prismjs",
        "highlight.js",
        "rehype-highlight"
      ].some((name) => packageNames.has(name)) ||
      /(?:from\s+["'](?:shiki|rehype-pretty-code|prismjs|highlight\.js|rehype-highlight)["']|require\(\s*["'](?:shiki|rehype-pretty-code|prismjs|highlight\.js|rehype-highlight)["'])/iu.test(
        code
      ),
    ...(globalStyle === undefined
      ? {}
      : { globalStyle }),
    globalStyleCandidates,
    ...(componentMap === undefined
      ? {}
      : { componentMap }),
    sourceScanTruncated: collection.truncated,
    packageNames,
    packageSpecifiers,
    packagePlacementIssues
  } satisfies ProjectInspection;
}

export async function planIntegrate(
  root: string,
  explicitMode: StyleMode | undefined,
  version: string
): Promise<IntegratePlan> {
  assertExactVersion(version);

  let inspection: ProjectInspection;
  try {
    inspection = await inspectProject(root);
  } catch (error) {
    throw new Error(
      `Could not inspect ${resolve(root)}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const recommendation = recommendStyleMode(inspection, explicitMode);
  const ambiguities = [...recommendation.ambiguities];
  const warnings: string[] = [];
  const manualSteps: string[] = [];

  if (inspection.packageManagerIssue !== undefined) {
    ambiguities.push(inspection.packageManagerIssue);
  }
  if (inspection.packagePlacementIssues.length > 0) {
    ambiguities.push(...inspection.packagePlacementIssues);
  }
  if (inspection.sourceScanTruncated) {
    ambiguities.push(
      "Project source inspection hit its safety limit before every candidate file could be inspected. Run Scribe from the application root or remove generated/vendor trees before integrating."
    );
  }

  if (
    inspection.globalStyle === undefined &&
    inspection.globalStyleCandidates.length > 1
  ) {
    ambiguities.push(
      `Multiple global stylesheet candidates were found (${inspection.globalStyleCandidates
        .map((path) => displayPath(inspection.root, path))
        .join(", ")}). Scribe will not guess which file is active.`
    );
  }

  const packages: PackageChange[] = [];
  const commands: PackageCommand[] = [];
  let alignment: AlignmentReport | undefined;

  if (
    inspection.packageManager !== undefined &&
    inspection.packageManagerRoot !== undefined
  ) {
    alignment = await checkPackageAlignment(
      inspection.root,
      version,
      inspection.packageManagerRoot
    );

    if (!alignment.inspectable) {
      ambiguities.push(
        formatAlignmentDiagnostic(alignment, inspection.packageManager)
      );
    } else if (
      !alignment.aligned ||
      !scribeDeclarationsAligned(inspection, version)
    ) {
      packages.push(
        ...scribePackageDefinitions.map((definition) => ({
          name: definition.name,
          version,
          development: definition.development
        }))
      );

      const convergence = scribeConvergenceCommands(
        inspection.packageManager,
        version
      );

      if (isAutomatedPackageManager(inspection.packageManager)) {
        commands.push(...convergence);
      } else {
        warnings.push(
          `Package installation is not automated for ${inspection.packageManager}; Scribe will not mutate source files until the package set is converged manually.`
        );
        manualSteps.push(
          ...convergence.map((command) => formatPackageCommand(command))
        );
      }
    }
  }

  const changes: FileChange[] = [];
  const transactionRoot = inspection.packageManagerRoot;

  if (recommendation.mode !== undefined) {
    const importLine = `@import "@scribe-sdk/styles/${recommendation.mode}.css";`;

    if (inspection.globalStyle === undefined) {
      if (inspection.globalStyleCandidates.length === 0) {
        manualSteps.push(
          `Import ${JSON.stringify(
            `@scribe-sdk/styles/${recommendation.mode}.css`
          )} once from the host application's active global stylesheet.`
        );
      }
    } else if (transactionRoot !== undefined) {
      const existing = await readFile(inspection.globalStyle, "utf8");
      const scribeImport = existing.match(
        /@scribe-sdk\/styles\/(foundation|default|tailwind)\.css/u
      )?.[1];

      if (
        scribeImport !== undefined &&
        scribeImport !== recommendation.mode
      ) {
        manualSteps.push(
          `Replace the existing ${scribeImport}.css import in ${displayPath(
            inspection.root,
            inspection.globalStyle
          )} only after reviewing the visual change to ${recommendation.mode} mode.`
        );
      } else if (scribeImport === undefined) {
        changes.push(
          await plannedFileChange(
            transactionRoot,
            inspection.root,
            inspection.globalStyle,
            `Add the ${recommendation.mode} stylesheet import`,
            insertCssImport(existing, importLine),
            { kind: "file", hash: hashContent(existing) }
          )
        );
      }
    }
  }

  addMdxIntegrationActions(
    inspection,
    transactionRoot,
    changes,
    ambiguities,
    manualSteps
  );

  if (inspection.hasSyntaxHighlighter) {
    warnings.push(
      "An existing syntax highlighter was detected. Review the overlap manually; integrate will not remove or replace it."
    );
  }

  const guards: GuardedFile[] = [...changes.map((change) => ({
    path: change.path,
    expected: change.expected
  }))];

  if (
    commands.length > 0 &&
    transactionRoot !== undefined &&
    inspection.packageManager !== undefined &&
    isAutomatedPackageManager(inspection.packageManager)
  ) {
    const applicationManifestPath = transactionRelativePath(
      transactionRoot,
      resolve(inspection.root, "package.json")
    );
    const packagePaths = manifestAndLockfilePaths(
      applicationManifestPath,
      inspection.packageManager
    );

    for (const path of packagePaths) {
      guards.push({
        path,
        expected: await captureExpectedFileState(transactionRoot, path)
      });
    }
  }

  return {
    inspection,
    ...(recommendation.mode === undefined ? {} : { mode: recommendation.mode }),
    reason: recommendation.reason,
    ambiguities: dedupeStrings(ambiguities),
    packages,
    commands,
    changes,
    guards: dedupeGuards(guards),
    warnings: dedupeStrings(warnings),
    manualSteps: dedupeStrings(manualSteps)
  };
}

export async function resolveProjectStyleMode(
  root: string,
  explicitMode?: StyleMode
): Promise<StyleModeResolution> {
  const inspection = await inspectProject(root);
  const recommendation = recommendStyleMode(inspection, explicitMode);
  return { inspection, ...recommendation };
}

export function recommendStyleMode(
  inspection: ProjectInspection,
  explicitMode?: StyleMode
): Omit<StyleModeResolution, "inspection"> {
  const ambiguities: string[] = [];
  let mode = explicitMode;
  let reason =
    explicitMode === undefined
      ? ""
      : `Selected explicitly with --mode ${explicitMode}.`;

  if (inspection.reactVersion === undefined) {
    ambiguities.push(
      "React was not detected in this package. Run Scribe from the application root."
    );
  }

  if (inspection.framework === undefined) {
    ambiguities.push(
      inspection.frameworkAmbiguity ??
        "Scribe integration currently supports React applications using Next.js or Vite; no unambiguous application framework was detected."
    );
  }

  if (inspection.sourceScanTruncated) {
    ambiguities.push(
      "Source inspection was incomplete because the scan safety limit was reached."
    );
  }

  if (
    mode === undefined &&
    inspection.tailwindMajor !== undefined &&
    (inspection.hasTypographyPlugin || inspection.hasProseUsage)
  ) {
    mode = "tailwind";
    reason = `Tailwind ${inspection.tailwindMajor} with an existing prose contract was detected.`;
  } else if (
    mode === undefined &&
    inspection.tailwindMajor !== undefined
  ) {
    ambiguities.push(
      "Tailwind is installed, but no Typography or .prose contract was found. Choose --mode foundation, default, or tailwind explicitly."
    );
  } else if (
    mode === undefined &&
    (inspection.hasEstablishedTypography || inspection.hasProseUsage)
  ) {
    mode = "foundation";
    reason = "Existing article typography and density rules were detected.";
  } else if (mode === undefined) {
    mode = "default";
    reason = "No established article typography was detected.";
  }

  return {
    ...(mode === undefined ? {} : { mode }),
    reason,
    ambiguities: dedupeStrings(ambiguities)
  };
}

export async function runIntegrate(
  args: readonly string[],
  dependencies: IntegrateDependencies
): Promise<number> {
  const stdout =
    dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr =
    dependencies.stderr ?? ((value: string) => process.stderr.write(value));
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
    plan = await planIntegrate(
      dependencies.cwd ?? process.cwd(),
      parsed.mode,
      dependencies.version
    );
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  stdout(formatIntegratePlan(plan, parsed.dryRun));

  if (
    plan.ambiguities.length > 0 ||
    plan.mode === undefined ||
    plan.inspection.packageManager === undefined ||
    plan.inspection.packageManagerRoot === undefined
  ) {
    return 2;
  }

  if (parsed.dryRun) return 0;

  const manager = plan.inspection.packageManager;
  if (
    plan.packages.length > 0 &&
    !isAutomatedPackageManager(manager)
  ) {
    stderr(deferredInstallMessage(plan));
    return 2;
  }

  const hasAutomaticWork =
    plan.commands.length > 0 || plan.changes.length > 0;

  if (!hasAutomaticWork) {
    if (plan.manualSteps.length > 0) {
      stdout(actionRequiredMessage(plan));
      return 3;
    }
    stdout(successMessage(plan, false));
    return 0;
  }

  let confirmed: boolean | null;
  if (parsed.yes) confirmed = true;
  else if (dependencies.confirm !== undefined) {
    confirmed = await dependencies.confirm(
      "Apply this Scribe integration plan?"
    );
  } else {
    confirmed = await confirmInteractively(
      "Apply this Scribe integration plan?"
    );
  }

  if (confirmed === null) {
    stderr(
      "The terminal is non-interactive.\nRe-run with `--yes` to apply the reviewed plan without a prompt.\n"
    );
    return 2;
  }
  if (confirmed === false) {
    stdout("Cancelled. No changes made.\n");
    return 0;
  }

  const projectRoot = plan.inspection.root;
  const transactionRoot = plan.inspection.packageManagerRoot;
  const runCommand = dependencies.runCommand ?? runPackageCommand;

  let lock: IntegrationLockHandle;
  try {
    lock = await acquireIntegrationLock(transactionRoot);
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  let snapshot: Map<string, SnapshotEntry> | undefined;
  let applied: readonly AppliedChange[] = [];
  let packageObserved: readonly AppliedChange[] = [];
  let exitCode = 0;
  let completionOutput = "";
  let failureOutput = "";

  try {
    await assertExpectedFileStates(transactionRoot, plan.guards);

    snapshot = await snapshotFiles(
      transactionRoot,
      plan.guards.map((guard) => guard.path)
    );

    for (const command of plan.commands) {
      let status: number;
      try {
        status = await runCommand(command, projectRoot);
      } finally {
        packageObserved = mergeAppliedChanges(
          packageObserved,
          await observeTrackedMutations(
            transactionRoot,
            snapshot,
            plan.guards.map((guard) => guard.path)
          )
        );
      }

      if (status !== 0) {
        throw new Error(
          `Command failed with status ${status}: ${formatPackageCommand(
            command
          )}`
        );
      }
    }

    applied = await applyFileChanges(transactionRoot, plan.changes);

    const alignment = await checkPackageAlignment(
      projectRoot,
      dependencies.version,
      transactionRoot
    );
    if (!alignment.aligned) {
      throw new Error(
        formatAlignmentDiagnostic(alignment, manager)
      );
    }

    const verification = await verificationOptions(
      plan,
      alignment,
      applied
    );
    const problems = await verifyIntegration(
      transactionRoot,
      verification
    );

    if (problems.length > 0) {
      throw new Error(problems.join("\n"));
    }

    if (plan.manualSteps.length > 0) {
      exitCode = 3;
      completionOutput = partialSuccessMessage(plan);
    } else {
      completionOutput = successMessage(
        plan,
        plan.commands.length > 0
      );
    }
  } catch (error) {
    if (snapshot === undefined) {
      exitCode = error instanceof FileStateConflictError ? 2 : 1;
      failureOutput = `${
        error instanceof Error ? error.message : String(error)
      }\n`;
    } else {
      const fileApplied =
        error instanceof FileTransactionError
          ? error.written
          : applied;

      const failures = await restoreSnapshot(
        transactionRoot,
        snapshot,
        mergeAppliedChanges(packageObserved, fileApplied)
      );

      exitCode = error instanceof FileStateConflictError ? 2 : 1;
      failureOutput = failureMessage(
        error,
        failures,
        plan.commands.length > 0
      );
    }
  }

  const failedBeforeLockRelease = failureOutput !== "";
  try {
    await releaseIntegrationLock(lock);
  } catch (error) {
    exitCode = 1;
    failureOutput +=
      `Could not safely release the Scribe integration lock: ${
        error instanceof Error ? error.message : String(error)
      }\n`;
  }

  if (completionOutput !== "" && !failedBeforeLockRelease) {
    stdout(completionOutput);
  }
  if (failureOutput !== "") stderr(failureOutput);
  return exitCode;
}

function parseIntegrateArguments(
  args: readonly string[]
):
  | {
      readonly dryRun: boolean;
      readonly yes: boolean;
      readonly help: boolean;
      readonly mode?: StyleMode;
    }
  | string {
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
      if (
        value === undefined ||
        !modes.has(value as StyleMode)
      ) {
        return `Invalid --mode value "${String(
          value
        )}". Expected one of: foundation, default, tailwind.`;
      }
      mode = value as StyleMode;
      index += 1;
    } else if (argument?.startsWith("--mode=")) {
      const value = argument.slice("--mode=".length);
      if (!modes.has(value as StyleMode)) {
        return `Invalid --mode value "${value}". Expected one of: foundation, default, tailwind.`;
      }
      mode = value as StyleMode;
    } else {
      const value = String(argument);
      const suggestion = suggestClosest(value, [
        "--dry-run",
        "--mode",
        "--yes",
        "--help"
      ]);
      return `Unknown integrate option "${value}".${
        suggestion === undefined
          ? ""
          : ` Did you mean "${suggestion}"?`
      }`;
    }
  }

  return {
    dryRun,
    yes,
    help,
    ...(mode === undefined ? {} : { mode })
  };
}

function formatIntegratePlan(
  plan: IntegratePlan,
  dryRun: boolean
): string {
  const detected = [
    `React ${plan.inspection.reactVersion ?? "not detected"}`,
    plan.inspection.framework === "next" ? "Next.js" : undefined,
    plan.inspection.framework === "vite" ? "Vite" : undefined,
    plan.inspection.tailwindMajor === undefined
      ? undefined
      : `Tailwind ${plan.inspection.tailwindMajor}`,
    plan.inspection.hasTypographyPlugin
      ? "Tailwind Typography"
      : undefined,
    plan.inspection.hasNextMdxRemote
      ? "next-mdx-remote/rsc"
      : undefined,
    plan.inspection.hasNextMdx ? "@next/mdx" : undefined,
    plan.inspection.hasViteMdx ? "Vite MDX" : undefined
  ]
    .filter(Boolean)
    .join(", ");

  const packageManager =
    plan.inspection.packageManager ?? "unresolved";
  const packageRoot =
    plan.inspection.packageManagerRoot === undefined
      ? "unresolved"
      : displayPath(
          plan.inspection.root,
          plan.inspection.packageManagerRoot
        );

  const lines = [
    `Scribe integrate — ${
      dryRun ? "dry run" : "reviewed plan"
    }`,
    dryRun
      ? "No files or packages will be changed."
      : "Review this plan before confirming changes.",
    "",
    "Detected",
    "  Project               .",
    `  Stack                 ${detected}`,
    `  Package manager       ${packageManager}`,
    `  Package-manager root  ${packageRoot}`,
    "",
    "Recommendation",
    `  Mode    ${plan.mode ?? "unresolved"}`,
    ...(plan.reason === ""
      ? []
      : [`  Reason  ${plan.reason}`]),
    "",
    "Commands",
    ...(plan.commands.length === 0
      ? ["  none"]
      : plan.commands.map(
          (command) => `  ${formatPackageCommand(command)}`
        )),
    "",
    "Packages",
    ...(plan.packages.length === 0
      ? ["  none"]
      : packageLines(plan.packages)),
    "",
    "File changes",
    ...(plan.changes.length === 0
      ? ["  none"]
      : plan.changes.map(
          (change) =>
            `  ${change.new ? "+" : "~"} ${
              change.applicationPath
            } — ${change.description}`
        )),
    "",
    "Warnings",
    ...(plan.warnings.length === 0
      ? ["  none"]
      : plan.warnings.flatMap((warning) =>
          warning
            .split("\n")
            .map((line) => `  ${line}`)
        )),
    "",
    "Required manual actions",
    ...(plan.manualSteps.length === 0
      ? ["  none"]
      : plan.manualSteps.map((step) => `  ${step}`))
  ];

  if (plan.ambiguities.length > 0) {
    lines.push(
      "",
      "Blocking ambiguities",
      ...plan.ambiguities.flatMap((value) =>
        value
          .split("\n")
          .map((line) => `  ${line}`)
      )
    );
  }

  lines.push(
    "",
    "Next",
    plan.ambiguities.length > 0 ||
      plan.mode === undefined ||
      plan.inspection.packageManager === undefined
      ? "  Resolve the blocking issues above, then rerun `scribe integrate --dry-run`."
      : dryRun
        ? plan.manualSteps.length > 0
          ? "  Review the automated plan and required manual actions, then run `scribe integrate`."
          : "  Review this plan, then run `scribe integrate` to confirm and apply it."
        : plan.manualSteps.length > 0
          ? "  Confirm the automated portion only if you will complete the required manual actions afterward."
          : "  Confirm only after the detected stack and proposed changes are correct."
  );

  return `${lines.join("\n")}\n`;
}

function packageLines(
  packages: readonly PackageChange[]
): string[] {
  const dependencies = packages.filter(
    (entry) => !entry.development
  );
  const development = packages.filter(
    (entry) => entry.development
  );
  const lines: string[] = [];

  if (dependencies.length > 0) {
    lines.push(
      "  dependencies",
      ...dependencies.map(
        (entry) => `    = ${entry.name}@${entry.version}`
      )
    );
  }
  if (development.length > 0) {
    lines.push(
      "  devDependencies",
      ...development.map(
        (entry) => `    = ${entry.name}@${entry.version}`
      )
    );
  }

  return lines;
}

function failureMessage(
  error: unknown,
  failures: readonly string[],
  packageCommandsRan: boolean
): string {
  const lines = [
    `Could not complete the Scribe integration: ${
      error instanceof Error ? error.message : String(error)
    }`,
    "",
    "Rollback",
    failures.length > 0
      ? `  Could not safely restore: ${failures.join(
          ", "
        )}. Review these paths manually before continuing.`
      : "  Restored the tracked manifest, lockfiles, and source files to their previous contents."
  ];

  if (packageCommandsRan) {
    lines.push(
      "",
      "Package-manager state",
      "  Scribe restored the tracked manifest/lockfiles, but package managers can also mutate node_modules, caches, and lifecycle-script state. If the install was interrupted or failed partway through, run your package manager's normal install command after reviewing the project."
    );
  }

  return `${lines.join("\n")}\n`;
}

function successMessage(
  plan: IntegratePlan,
  installedSomething: boolean
): string {
  const lines = [
    "Success  Scribe integrated",
    `  Mode           ${plan.mode}`,
    "",
    "Packages",
    plan.packages.length === 0
      ? "  already aligned"
      : plan.packages
          .map(
            (entry) =>
              `  = ${entry.name}@${entry.version}${
                entry.development ? " (dev)" : ""
              }`
          )
          .join("\n"),
    "",
    "Changed files",
    plan.changes.length === 0
      ? "  none"
      : plan.changes
          .map(
            (change) =>
              `  ${change.new ? "+" : "~"} ${
                change.applicationPath
              }`
          )
          .join("\n"),
    "",
    "Warnings",
    plan.warnings.length === 0
      ? "  none"
      : plan.warnings
          .flatMap((warning) =>
            warning
              .split("\n")
              .map((line) => `  ${line}`)
          )
          .join("\n"),
    "",
    "Next",
    "  Run `scribe validate path/to/article.mdx`."
  ];

  if (installedSomething) {
    lines.push(
      "",
      "Scribe packages are pinned to the running CLI version.",
      "",
      "Daily commands",
      "  scribe studio <article>",
      "  scribe validate <article>"
    );
  }

  return `${lines.join("\n")}\n`;
}

function partialSuccessMessage(plan: IntegratePlan): string {
  return [
    "Action required  Automated Scribe changes applied",
    `  Mode           ${plan.mode}`,
    "",
    "The automated portion verified successfully, but Scribe is not fully integrated yet.",
    "",
    "Required manual actions",
    ...plan.manualSteps.map((step) => `  ${step}`),
    "",
    "After completing them, run `scribe validate path/to/article.mdx`."
  ].join("\n") + "\n";
}

function actionRequiredMessage(plan: IntegratePlan): string {
  return [
    "Action required  No automated changes were necessary",
    "",
    "Scribe cannot honestly report a complete integration until these actions are finished:",
    "",
    ...plan.manualSteps.map((step) => `  ${step}`),
    ""
  ].join("\n");
}

function deferredInstallMessage(plan: IntegratePlan): string {
  const manager = plan.inspection.packageManager;
  if (manager === undefined) {
    return "Could not determine the package manager; no changes were made.\n";
  }

  const commands = scribeConvergenceCommands(
    manager,
    plan.packages[0]?.version ?? ""
  );

  return [
    `This project uses ${manager}, whose package installation is not automated yet.`,
    "Integrate stopped without changing files. Converge the Scribe packages with these commands, then re-run it:",
    "",
    ...commands.map(
      (command) => `  ${formatPackageCommand(command)}`
    ),
    ""
  ].join("\n");
}

async function verificationOptions(
  plan: IntegratePlan,
  alignment: AlignmentReport,
  applied: readonly AppliedChange[]
): Promise<Parameters<typeof verifyIntegration>[1]> {
  const transactionRoot = plan.inspection.packageManagerRoot;
  if (transactionRoot === undefined) {
    throw new Error(
      "Cannot verify integration without a package-manager root."
    );
  }

  const resolvedPackages = alignment.installed.filter(
    (
      entry
    ): entry is InstalledPackageVersion & {
      readonly status: "resolved";
      readonly version: string;
      readonly manifestPath: string;
    } =>
      entry.status === "resolved" &&
      entry.version !== undefined &&
      entry.manifestPath !== undefined
  );

  const styles = resolvedPackages.find(
    (entry) => entry.packageName === "@scribe-sdk/styles"
  );

  return {
    packages: resolvedPackages.map((entry) => ({
      name: entry.packageName,
      version: alignment.expected,
      manifestPath: transactionRelativePath(
        transactionRoot,
        entry.manifestPath
      )
    })),
    ...(styles === undefined || plan.mode === undefined
      ? {}
      : {
          stylesheet: {
            packageDirectory: transactionRelativePath(
              transactionRoot,
              dirname(styles.manifestPath)
            ),
            mode: plan.mode
          }
        }),
    files: applied.map((change) => ({
      path: change.path,
      expectedHash: change.writtenHash
    }))
  };
}

function addMdxIntegrationActions(
  inspection: ProjectInspection,
  transactionRoot: string | undefined,
  changes: FileChange[],
  ambiguities: string[],
  manualSteps: string[]
): void {
  if (inspection.framework === "next") {
    if (inspection.hasNextMdx && inspection.hasNextMdxRemote) {
      ambiguities.push(
        "Both @next/mdx and next-mdx-remote/rsc appear to be active. Scribe will not guess which compiler/render boundary owns article MDX."
      );
      return;
    }

    if (inspection.hasNextMdx) {
      if (!inspection.hasScribeCompiler) {
        manualSteps.push(
          "Merge createScribeNextMdxOptions() into the active @next/mdx loader options without replacing unrelated remark or rehype plugins."
        );
      }

      if (!inspection.hasScribeComponents) {
        if (
          inspection.componentMap === undefined &&
          transactionRoot !== undefined
        ) {
          const absolute = resolve(
            inspection.root,
            "mdx-components.tsx"
          );
          const path = transactionRelativePath(
            transactionRoot,
            absolute
          );
          changes.push({
            path,
            applicationPath: displayPath(
              inspection.root,
              absolute
            ),
            description: "Create the Next.js MDX component map",
            content:
              'import { createScribeComponents, type ScribeComponents } from "@scribe-sdk/react";\n\nexport function useMDXComponents(components: ScribeComponents): ScribeComponents {\n  return createScribeComponents({ components });\n}\n',
            expected: { kind: "missing" },
            new: true
          });
        } else if (inspection.componentMap === undefined) {
          manualSteps.push(
            "Create the Next.js MDX component map and connect createScribeComponents() while preserving any application-owned component overrides."
          );
        } else {
          manualSteps.push(
            "Connect createScribeComponents() in the existing Next.js MDX component map while preserving every current component override."
          );
        }
      }
      return;
    }

    if (inspection.hasNextMdxRemote) {
      if (!inspection.hasScribeCompiler) {
        manualSteps.push(
          "Use createScribeRemoteMdxOptions() from @scribe-sdk/mdx/next-remote in the active MDXRemote options prop."
        );
      }
      if (!inspection.hasScribeComponents) {
        manualSteps.push(
          "Connect createScribeComponents() at the component map passed to the active next-mdx-remote/rsc renderer; preserve existing overrides."
        );
      }
      return;
    }

    manualSteps.push(
      "No active Next.js MDX compilation pipeline was detected. Wire Scribe into the actual @next/mdx or next-mdx-remote/rsc boundary before treating the integration as complete."
    );
    if (!inspection.hasScribeComponents) {
      manualSteps.push(
        "Connect createScribeComponents() at the application's real MDX render boundary."
      );
    }
    return;
  }

  if (inspection.framework === "vite") {
    if (!inspection.hasViteMdx) {
      manualSteps.push(
        "No active Vite MDX plugin was detected. Configure the application's real MDX compilation pipeline before wiring Scribe."
      );
    } else if (!inspection.hasScribeCompiler) {
      manualSteps.push(
        "Merge createScribeMdxOptions() into the active Vite MDX plugin while preserving unrelated remark and rehype plugins."
      );
    }

    if (!inspection.hasScribeComponents) {
      manualSteps.push(
        "Connect createScribeComponents() at the application's real MDX render boundary; preserve existing component overrides."
      );
    }
  }
}

async function plannedFileChange(
  transactionRoot: string,
  applicationRoot: string,
  absolutePath: string,
  description: string,
  content: string,
  capturedExpected?: ExpectedFileState
): Promise<FileChange> {
  const path = transactionRelativePath(
    transactionRoot,
    absolutePath
  );
  const expected =
    capturedExpected ??
    (await captureExpectedFileState(transactionRoot, path));

  return {
    path,
    applicationPath: displayPath(
      applicationRoot,
      absolutePath
    ),
    description,
    content,
    expected,
    new: expected.kind === "missing"
  };
}

function scribeDeclarationsAligned(
  inspection: ProjectInspection,
  version: string
): boolean {
  return scribePackageDefinitions.every((definition) => {
    const declaration = inspection.packageSpecifiers.get(
      definition.name
    );
    return (
      declaration !== undefined &&
      declaration.specifier === version &&
      declaration.development === definition.development
    );
  });
}


async function collectSourceFiles(
  inputRoot: string
): Promise<SourceCollection> {
  const root = await realpath(inputRoot).catch(() =>
    resolve(inputRoot)
  );
  const files: string[] = [];
  let truncated = false;
  const maxFiles = 1_500;
  const maxDepth = 10;

  async function visit(
    directory: string,
    depth: number
  ): Promise<void> {
    if (depth > maxDepth) {
      truncated = true;
      return;
    }

    const entries = await readdir(directory, {
      withFileTypes: true
    }).catch(() => undefined);
    if (entries === undefined) {
      truncated = true;
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith(".")) continue;

      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await visit(path, depth + 1);
        }
      } else if (
        entry.isFile() &&
        sourceExtensions.test(entry.name)
      ) {
        files.push(path);
      }
    }
  }

  await visit(root, 0);

  const contents = await mapWithConcurrency(
    files,
    32,
    async (path): Promise<SourceEntry> => ({
      path,
      relativePath: relative(root, path).replaceAll("\\", "/"),
      content: await readFile(path, "utf8")
    })
  );

  return { entries: contents, truncated };
}

async function detectFramework(
  root: string,
  hasNext: boolean,
  hasVite: boolean,
  hasNextConfig: boolean,
  hasViteConfig: boolean
): Promise<{
  readonly framework?: Framework;
  readonly reason?: string;
  readonly ambiguity?: string;
}> {
  if (hasNext && !hasVite) {
    return {
      framework: "next",
      reason: "Next.js is declared by the application."
    };
  }
  if (hasVite && !hasNext) {
    return {
      framework: "vite",
      reason: "Vite is declared by the application."
    };
  }
  if (!hasNext && !hasVite) return {};

  const hasNextStructure =
    hasNextConfig ||
    (await anyPathExists(root, [
      "app",
      "src/app",
      "pages",
      "src/pages"
    ]));
  const hasViteStructure =
    hasViteConfig ||
    (await anyPathExists(root, [
      "index.html",
      "src/main.tsx",
      "src/main.ts",
      "src/main.jsx",
      "src/main.js"
    ]));

  if (hasNextStructure && !hasViteStructure) {
    return {
      framework: "next",
      reason:
        "Both Next.js and Vite are installed, but only the Next.js application boundary was detected."
    };
  }
  if (hasViteStructure && !hasNextStructure) {
    return {
      framework: "vite",
      reason:
        "Both Next.js and Vite are installed, but only the Vite application boundary was detected."
    };
  }

  return {
    ambiguity:
      "Both Next.js and Vite appear to define application boundaries in this package. Run Scribe from the intended application package rather than guessing across a mixed root."
  };
}

async function existingCandidates(
  root: string,
  candidates: readonly string[]
): Promise<readonly string[]> {
  const existing: string[] = [];
  for (const candidate of candidates) {
    const path = resolve(root, candidate);
    if (await pathExists(path)) existing.push(path);
  }
  return existing;
}

function chooseGlobalStyle(
  root: string,
  candidates: readonly string[],
  codeEntries: readonly SourceEntry[]
): string | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const referenced = candidates.filter((candidate) => {
    const relativeCandidate = relative(root, candidate).replaceAll(
      "\\",
      "/"
    );
    const filename = basename(candidate);

    return codeEntries.some((entry) => {
      const content = entry.content.replaceAll("\\", "/");
      return (
        content.includes(relativeCandidate) ||
        new RegExp(
          `(?:import\\s+|require\\(\\s*)["'][^"']*${escapeRegExp(
            filename
          )}["']`,
          "u"
        ).test(content)
      );
    });
  });

  return referenced.length === 1 ? referenced[0] : undefined;
}

function insertCssImport(
  existing: string,
  importLine: string
): string {
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const bom = existing.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom === "" ? existing : existing.slice(1);

  let cursor = 0;

  const charset = /^@charset[^\r\n]*;\r?\n?/u.exec(body);
  if (charset !== null) cursor = charset[0].length;

  for (;;) {
    const remaining = body.slice(cursor);
    const whitespace = /^[ \t]*(?:\r?\n)?/u.exec(remaining)?.[0] ?? "";
    const afterWhitespace = remaining.slice(whitespace.length);
    const nextImport = /^@import[^\r\n]*;\r?\n?/u.exec(
      afterWhitespace
    );
    if (nextImport === null) break;
    cursor += whitespace.length + nextImport[0].length;
  }

  const prefix = body.slice(0, cursor);
  const suffix = body.slice(cursor);
  const needsPrefixNewline =
    prefix.length > 0 &&
    !prefix.endsWith("\n") &&
    !prefix.endsWith("\r");
  const separator = needsPrefixNewline ? newline : "";

  if (prefix.length === 0) {
    return `${bom}${importLine}${newline}${newline}${body}`;
  }

  return `${bom}${prefix}${separator}${importLine}${newline}${suffix}`;
}

function parseTailwindMajor(
  version: string | undefined
): 3 | 4 | undefined {
  if (version === undefined) return undefined;
  const normalized = version
    .trim()
    .replace(/^[\s<=>~^]*/u, "");
  const match = /^(\d+)(?:\.|$)/u.exec(normalized);
  const major =
    match === null ? undefined : Number(match[1]);
  return major === 3 || major === 4
    ? major
    : undefined;
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  map: (value: Input) => Promise<Output>
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;

  const worker = async () => {
    for (;;) {
      const index = nextIndex;
      if (index >= values.length) return;
      nextIndex += 1;
      results[index] = await map(values[index] as Input);
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      worker
    )
  );
  return results;
}

function displayPath(root: string, path: string): string {
  const value = relative(root, path);
  return value === "" ? "." : value.replaceAll("\\", "/");
}

function transactionRelativePath(
  transactionRoot: string,
  absolutePath: string
): string {
  const value = relative(transactionRoot, absolutePath);
  if (
    value === "" ||
    value === ".." ||
    value.startsWith(`..${sep}`) ||
    isAbsolute(value)
  ) {
    throw new Error(
      `${absolutePath} is outside package-manager root ${transactionRoot}.`
    );
  }
  return value.replaceAll("\\", "/");
}

async function confirmInteractively(
  question: string
): Promise<boolean | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return null;
  }

  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    return /^(?:y|yes)$/iu.test(
      (await prompt.question(`${question} [y/N] `)).trim()
    );
  } finally {
    prompt.close();
  }
}


async function canonicalDirectory(
  input: string
): Promise<string> {
  const absolute = resolve(input);
  try {
    return await realpath(absolute);
  } catch (error) {
    throw new Error(
      `Could not resolve project directory ${absolute}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function readManifest(path: string): Promise<{
  readonly packageManager?: unknown;
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
}> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  try {
    return JSON.parse(source) as {
      readonly packageManager?: unknown;
      readonly dependencies?: unknown;
      readonly devDependencies?: unknown;
    };
  } catch (error) {
    throw new Error(
      `Could not parse ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function normalizeDependencyRecord(
  value: unknown,
  field: string,
  manifestPath: string
): Record<string, string> {
  if (value === undefined) return {};
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(
      `${field} in ${manifestPath} must be an object.`
    );
  }

  const result: Record<string, string> = {};
  for (const [name, specifier] of Object.entries(value)) {
    if (typeof specifier !== "string") {
      throw new Error(
        `${field}.${name} in ${manifestPath} must be a string.`
      );
    }
    result[name] = specifier;
  }
  return result;
}

async function firstExisting(
  root: string,
  candidates: readonly string[]
): Promise<string | undefined> {
  for (const candidate of candidates) {
    const path = resolve(root, candidate);
    if (await pathExists(path)) return path;
  }
  return undefined;
}

async function anyPathExists(
  root: string,
  candidates: readonly string[]
): Promise<boolean> {
  for (const candidate of candidates) {
    if (await pathExists(resolve(root, candidate))) return true;
  }
  return false;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw error;
  }
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function dedupeGuards(
  guards: readonly GuardedFile[]
): GuardedFile[] {
  const result = new Map<string, GuardedFile>();
  for (const guard of guards) {
    const existing = result.get(guard.path);
    if (
      existing !== undefined &&
      JSON.stringify(existing.expected) !==
        JSON.stringify(guard.expected)
    ) {
      throw new Error(
        `Conflicting expected states were recorded for ${guard.path}.`
      );
    }
    result.set(guard.path, guard);
  }
  return [...result.values()];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function assertExactVersion(version: string): void {
  const normalized = version.trim();
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
      normalized
    )
  ) {
    throw new Error(
      `Expected an exact Scribe version, received ${JSON.stringify(
        version
      )}.`
    );
  }
}

function isFileSystemError(
  error: unknown,
  code: string
): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}
