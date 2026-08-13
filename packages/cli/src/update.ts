import { relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";

import { updateHelp } from "./command-help.js";
import { findSupportedProjectRoot } from "./launcher.js";
import {
  detectPackageManagerContext,
  formatPackageCommand,
  isAutomatedPackageManager,
  runPackageCommand,
  scribeConvergenceCommands,
  type PackageCommand,
  type PackageManagerContext
} from "./package-manager.js";
import {
  acquireIntegrationLock,
  assertExpectedFileStates,
  captureExpectedFileState,
  manifestAndLockfilePaths,
  mergeAppliedChanges,
  observeTrackedMutations,
  releaseIntegrationLock,
  restoreSnapshot,
  snapshotFiles,
  type AppliedChange,
  type IntegrationLockHandle,
  type SnapshotEntry
} from "./transaction.js";
import {
  checkPackageAlignment,
  formatAlignmentDiagnostic,
  scribePackageDefinitions,
  type AlignmentReport
} from "./version-alignment.js";

export const scribePrereleaseChannel = "beta";

export interface UpdateDependencies {
  readonly cwd?: string;
  readonly version: string;
  readonly stdout?: (value: string) => void;
  readonly stderr?: (value: string) => void;
  readonly confirm?: (question: string) => Promise<boolean | null>;
  readonly resolveTarget?: () => Promise<string>;
  readonly runCommand?: (command: PackageCommand, cwd: string) => Promise<number>;
  readonly inspectAlignment?: typeof checkPackageAlignment;
}

interface ParsedUpdateArguments {
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly help: boolean;
}

export async function resolveScribePrereleaseTarget(
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const versions = await Promise.all(scribePackageDefinitions.map(async ({ name }) => {
    const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
      throw new Error(`npm registry returned ${response.status} for ${name}.`);
    }
    const manifest = await response.json() as { readonly "dist-tags"?: Readonly<Record<string, unknown>> };
    const version = manifest["dist-tags"]?.[scribePrereleaseChannel];
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) {
      throw new Error(`${name} does not expose a valid ${scribePrereleaseChannel} dist-tag.`);
    }
    return { name, version };
  }));
  const distinct = new Set(versions.map(({ version }) => version));
  if (distinct.size !== 1) {
    throw new Error(`Scribe's ${scribePrereleaseChannel} dist-tags are not aligned: ${versions.map(({ name, version }) => `${name}@${version}`).join(", ")}.`);
  }
  return versions[0]?.version as string;
}

export async function runUpdate(
  args: readonly string[],
  dependencies: UpdateDependencies
): Promise<number> {
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = dependencies.stderr ?? ((value: string) => process.stderr.write(value));
  const parsed = parseUpdateArguments(args);
  if (typeof parsed === "string") {
    stderr(`${parsed}\n${updateHelp}`);
    return 2;
  }
  if (parsed.help) {
    stdout(updateHelp);
    return 0;
  }

  let projectRoot: string;
  let context: PackageManagerContext;
  let before: AlignmentReport;
  let target: string;
  try {
    const detectedRoot = await findSupportedProjectRoot(dependencies.cwd ?? process.cwd());
    if (detectedRoot === undefined) {
      throw new Error("No supported Next.js or Vite project was found. Run `scribe update` from the project you want to update.");
    }
    projectRoot = detectedRoot;
    context = await detectPackageManagerContext(projectRoot);
    before = await (dependencies.inspectAlignment ?? checkPackageAlignment)(
      projectRoot,
      dependencies.version,
      context.packageManagerRoot
    );
    if (!before.inspectable) {
      throw new Error(formatAlignmentDiagnostic(before, context.manager));
    }
    target = await (dependencies.resolveTarget ?? resolveScribePrereleaseTarget)();
  } catch (error) {
    stderr(`Scribe update could not inspect the installation: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const commands = scribeConvergenceCommands(context.manager, target);
  stdout(formatUpdatePlan(before, target, context.manager, commands, parsed.dryRun));
  if (before.installed.every((entry) => entry.status === "resolved" && entry.version === target)) {
    stdout(`Already current. All four Scribe packages resolve at ${target}.\n`);
    return 0;
  }
  if (parsed.dryRun) return 0;
  if (!isAutomatedPackageManager(context.manager)) {
    stderr(`Automatic updates currently use Bun or npm. Run the commands shown above with ${context.manager}, then run \`scribe update\` again to verify alignment.\n`);
    return 2;
  }

  const confirmed = parsed.yes
    ? true
    : await (dependencies.confirm ?? confirmInteractively)("Apply update?");
  if (confirmed === null) {
    stderr("The terminal is non-interactive. Re-run with --yes to apply the reviewed update.\n");
    return 2;
  }
  if (!confirmed) {
    stdout("Cancelled. No package-manager commands were run.\n");
    return 0;
  }

  const applicationManifest = relative(context.packageManagerRoot, resolve(projectRoot, "package.json")).split(sep).join("/");
  const trackedPaths = manifestAndLockfilePaths(applicationManifest, context.manager);
  const guards = await Promise.all(trackedPaths.map(async (path) => ({
    path,
    expected: await captureExpectedFileState(context.packageManagerRoot, path)
  })));
  const runCommand = dependencies.runCommand ?? runPackageCommand;

  let lock: IntegrationLockHandle;
  try {
    lock = await acquireIntegrationLock(context.packageManagerRoot);
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  let snapshot: Map<string, SnapshotEntry> | undefined;
  let observed: readonly AppliedChange[] = [];
  let failure = "";
  try {
    await assertExpectedFileStates(context.packageManagerRoot, guards);
    snapshot = await snapshotFiles(context.packageManagerRoot, trackedPaths);
    for (const command of commands) {
      let status: number;
      try {
        status = await runCommand(command, projectRoot);
      } finally {
        observed = mergeAppliedChanges(
          observed,
          await observeTrackedMutations(context.packageManagerRoot, snapshot, trackedPaths)
        );
      }
      if (status !== 0) {
        throw new Error(`Command failed with status ${status}: ${formatPackageCommand(command)}`);
      }
    }

    const after = await (dependencies.inspectAlignment ?? checkPackageAlignment)(
      projectRoot,
      target,
      context.packageManagerRoot
    );
    if (!after.aligned) throw new Error(formatAlignmentDiagnostic(after, context.manager));
  } catch (error) {
    const restored = snapshot === undefined
      ? []
      : await restoreSnapshot(context.packageManagerRoot, snapshot, observed);
    failure = [
      `Scribe update failed: ${error instanceof Error ? error.message : String(error)}`,
      snapshot === undefined
        ? "No package files were changed by Scribe."
        : restored.length === 0
          ? "The project manifest and lockfile snapshot was restored. node_modules may still require a normal package-manager install."
          : `Rollback could not safely restore: ${restored.join(", ")}.`,
      "Scribe did not report the installation as updated."
    ].join("\n");
  }

  try {
    await releaseIntegrationLock(lock);
  } catch (error) {
    failure += `${failure === "" ? "" : "\n"}Could not safely release the Scribe integration lock: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (failure !== "") {
    stderr(`${failure}\n`);
    return 1;
  }
  stdout(`Updated. All four Scribe packages now resolve at ${target}.\n`);
  return 0;
}

function parseUpdateArguments(args: readonly string[]): ParsedUpdateArguments | string {
  let dryRun = false;
  let yes = false;
  let help = false;
  for (const argument of args) {
    if (argument === "--dry-run") dryRun = true;
    else if (argument === "--yes") yes = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else return `Unknown update option "${argument}".`;
  }
  return { dryRun, yes, help };
}

function formatUpdatePlan(
  report: AlignmentReport,
  target: string,
  manager: string,
  commands: readonly PackageCommand[],
  dryRun: boolean
): string {
  const resolved = report.installed.filter((entry) => entry.status === "resolved");
  const versions = new Set(resolved.map(({ version }) => version));
  const current = resolved.length === scribePackageDefinitions.length && versions.size === 1
    ? resolved[0]?.version
    : "mixed";
  return [
    `Scribe update${dryRun ? " — dry run" : ""}`,
    "",
    `${current ?? "unknown"} → ${target}`,
    "",
    ...report.installed.map((entry) => `  ${entry.packageName}  ${entry.status === "resolved" ? entry.version : entry.status}`),
    "",
    `Package manager: ${manager}`,
    "",
    "Operation",
    ...commands.map((command) => `  ${formatPackageCommand(command)}`),
    ""
  ].join("\n");
}

async function confirmInteractively(question: string): Promise<boolean | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(`${question} [Y/n] `)).trim();
    return !/^(?:n|no)$/iu.test(answer);
  } finally {
    prompt.close();
  }
}

