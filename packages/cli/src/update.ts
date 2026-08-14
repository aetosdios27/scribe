import { relative, resolve, sep } from "node:path";

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
  type ExpectedFileState,
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


export async function resolveScribePrereleaseTarget(
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const versions = await Promise.all(scribePackageDefinitions.map(async ({ name }) => {
    const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      headers: { accept: "application/vnd.npm.install-v1+json, application/json" },
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

export interface UpdatePlan {
  readonly projectRoot: string;
  readonly context: PackageManagerContext;
  readonly before: AlignmentReport;
  readonly target: string;
  readonly commands: readonly PackageCommand[];
  readonly trackedPaths: readonly string[];
  readonly guards: readonly {
    readonly path: string;
    readonly expected: ExpectedFileState;
  }[];
}

export interface UpdateApplyEvent {
  readonly type: "task.started" | "task.completed";
  readonly task: string;
  readonly detail?: string;
}

export interface UpdateApplyResult {
  readonly changed: boolean;
  readonly target: string;
}

export class UpdateOperationError extends Error {
  public constructor(
    message: string,
    public readonly recovery: readonly string[],
    public readonly partialState: boolean,
    public readonly usage = false
  ) {
    super(message);
    this.name = "UpdateOperationError";
  }
}

export async function planScribeUpdate(
  cwd: string,
  version: string,
  dependencies: {
    readonly resolveTarget?: () => Promise<string>;
    readonly inspectAlignment?: typeof checkPackageAlignment;
  } = {}
): Promise<UpdatePlan> {
  const projectRoot = await findSupportedProjectRoot(cwd);
  if (projectRoot === undefined) {
    throw new UpdateOperationError(
      "No supported Next.js or Vite project was found.",
      ["Run `scribe update` from the project you want to update."],
      false,
      true
    );
  }
  const context = await detectPackageManagerContext(projectRoot);
  const inspectAlignment = dependencies.inspectAlignment ?? checkPackageAlignment;
  const before = await inspectAlignment(projectRoot, version, context.packageManagerRoot);
  if (!before.inspectable) {
    throw new UpdateOperationError(
      formatAlignmentDiagnostic(before, context.manager),
      [],
      false
    );
  }
  const target = await (dependencies.resolveTarget ?? resolveScribePrereleaseTarget)();
  const commands = scribeConvergenceCommands(context.manager, target);
  const applicationManifest = relative(
    context.packageManagerRoot,
    resolve(projectRoot, "package.json")
  ).split(sep).join("/");
  const trackedPaths = isAutomatedPackageManager(context.manager)
    ? manifestAndLockfilePaths(applicationManifest, context.manager)
    : [];
  const guards = await Promise.all(trackedPaths.map(async (path) => ({
    path,
    expected: await captureExpectedFileState(context.packageManagerRoot, path)
  })));
  return {
    projectRoot,
    context,
    before,
    target,
    commands,
    trackedPaths,
    guards
  };
}

export async function applyScribeUpdatePlan(
  plan: UpdatePlan,
  dependencies: {
    readonly runCommand?: (command: PackageCommand, cwd: string) => Promise<number>;
    readonly inspectAlignment?: typeof checkPackageAlignment;
    readonly releaseLock?: typeof releaseIntegrationLock;
    readonly onEvent?: (event: UpdateApplyEvent) => void;
  } = {}
): Promise<UpdateApplyResult> {
  if (
    plan.before.installed.every(
      (entry) => entry.status === "resolved" && entry.version === plan.target
    )
  ) {
    return { changed: false, target: plan.target };
  }
  if (!isAutomatedPackageManager(plan.context.manager)) {
    throw new UpdateOperationError(
      `Automatic updates currently use Bun or npm, not ${plan.context.manager}.`,
      plan.commands.map(formatPackageCommand),
      false,
      true
    );
  }
  const emit = (type: UpdateApplyEvent["type"], task: string, detail?: string) => {
    dependencies.onEvent?.({
      type,
      task,
      ...(detail === undefined ? {} : { detail })
    });
  };
  const runCommand = dependencies.runCommand ?? runPackageCommand;
  const inspectAlignment = dependencies.inspectAlignment ?? checkPackageAlignment;
  const lock = await acquireIntegrationLock(plan.context.packageManagerRoot);
  let snapshot: Map<string, SnapshotEntry> | undefined;
  let observed: readonly AppliedChange[] = [];
  let operationError: UpdateOperationError | undefined;
  try {
    emit("task.started", "Snapshot package files");
    await assertExpectedFileStates(plan.context.packageManagerRoot, plan.guards);
    snapshot = await snapshotFiles(plan.context.packageManagerRoot, plan.trackedPaths);
    emit("task.completed", "Snapshot package files");
    for (const [index, command] of plan.commands.entries()) {
      const task = index === 0 ? "Update runtime packages" : "Update project CLI";
      const shown = formatPackageCommand(command);
      emit("task.started", task, shown);
      let status: number;
      try {
        status = await runCommand(command, plan.projectRoot);
      } finally {
        observed = mergeAppliedChanges(
          observed,
          await observeTrackedMutations(
            plan.context.packageManagerRoot,
            snapshot,
            plan.trackedPaths
          )
        );
      }
      if (status !== 0) throw new Error(`Command failed with status ${status}: ${shown}`);
      emit("task.completed", task);
    }
    emit("task.started", "Verify package alignment");
    const after = await inspectAlignment(
      plan.projectRoot,
      plan.target,
      plan.context.packageManagerRoot
    );
    if (!after.aligned) {
      throw new Error(formatAlignmentDiagnostic(after, plan.context.manager));
    }
    emit("task.completed", "Verify package alignment");
  } catch (error) {
    const restored = snapshot === undefined
      ? []
      : await restoreSnapshot(plan.context.packageManagerRoot, snapshot, observed);
    operationError = new UpdateOperationError(
      error instanceof Error ? error.message : String(error),
      [
        snapshot === undefined
          ? "No package files were changed by Scribe."
          : restored.length === 0
            ? "The project manifest and lockfile snapshot was restored. Run a normal package-manager install if node_modules changed."
            : `Rollback could not safely restore: ${restored.join(", ")}.`
      ],
      restored.length > 0 || observed.length > 0
    );
  }
  try {
    await (dependencies.releaseLock ?? releaseIntegrationLock)(lock);
  } catch (error) {
    const message = `Could not safely release the Scribe integration lock: ${
      error instanceof Error ? error.message : String(error)
    }`;
    operationError = operationError === undefined
      ? new UpdateOperationError(message, [], true)
      : new UpdateOperationError(
        operationError.message,
        [...operationError.recovery, message],
        true,
        operationError.usage
      );
  }
  if (operationError !== undefined) throw operationError;
  return { changed: true, target: plan.target };
}



