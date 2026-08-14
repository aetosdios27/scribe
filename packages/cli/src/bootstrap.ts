#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  delegateToLocalCli,
  resolveExecutionContext,
  shouldDelegate
} from "./launcher.js";

const modulePath = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(modulePath), "..");

export interface RuntimePlatform {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly libc?: "gnu" | "musl";
}

export interface NativeSelection {
  readonly packageName: string;
  readonly binary: string;
}

export function selectNativePackage(runtime: RuntimePlatform): NativeSelection {
  if (runtime.platform === "linux") {
    const libc = runtime.libc ?? detectLibc();

    if (runtime.arch === "x64") {
      return native("cli-linux-x64-", libc, "scribe-cli");
    }

    if (runtime.arch === "arm64") {
      return native("cli-linux-arm64-", libc, "scribe-cli");
    }
  }

  if (
    runtime.platform === "darwin" &&
    (runtime.arch === "x64" || runtime.arch === "arm64")
  ) {
    return native(`cli-darwin-${runtime.arch}`, undefined, "scribe-cli");
  }

  if (
    runtime.platform === "win32" &&
    (runtime.arch === "x64" || runtime.arch === "arm64")
  ) {
    return native(
      `cli-win32-${runtime.arch}-msvc`,
      undefined,
      "scribe-cli.exe"
    );
  }

  throw new Error(
    `Scribe does not provide a native CLI for ${runtime.platform}/${runtime.arch}.`
  );
}

export async function resolveNativeBinary(
  root = packageRoot,
  runtime: RuntimePlatform = {
    platform: process.platform,
    arch: process.arch
  }
): Promise<{
  readonly path: string;
  readonly selection: NativeSelection;
}> {
  const selection = selectNativePackage(runtime);
  const require = createRequire(resolve(root, "package.json"));

  const manifestPath = require.resolve(
    `${selection.packageName}/package.json`
  );

  const packageDirectory = dirname(manifestPath);

  const manifest = object(
    JSON.parse(await readFile(manifestPath, "utf8")) as unknown
  );

  const cliManifest = object(
    JSON.parse(
      await readFile(resolve(root, "package.json"), "utf8")
    ) as unknown
  );

  const version = requiredString(
    manifest.version,
    `${selection.packageName} version`
  );

  const cliVersion = requiredString(
    cliManifest.version,
    "@scribe-sdk/cli version"
  );

  if (version !== cliVersion) {
    throw new Error(
      `${selection.packageName}@${version} does not match @scribe-sdk/cli@${cliVersion}.`
    );
  }

  const path = resolve(
    packageDirectory,
    "bin",
    selection.binary
  );

  await access(path);

  return {
    path,
    selection
  };
}

export async function runBootstrap(
  args: readonly string[] = process.argv.slice(2),
  env: Readonly<NodeJS.ProcessEnv> = process.env
): Promise<number> {
  const context = await resolveExecutionContext({
    ...(process.argv[1] === undefined
      ? {}
      : { argv1: process.argv[1] }),
    cwd: process.cwd(),
    env,
    packageRoot,
    packageVersion: requiredString(
      object(
        JSON.parse(
          await readFile(
            resolve(packageRoot, "package.json"),
            "utf8"
          )
        ) as unknown
      ).version,
      "@scribe-sdk/cli version"
    )
  });

  if (shouldDelegate(context)) {
    return delegateToLocalCli(context, args, {
      env: {
        ...env,
        SCRIBE_LAUNCHER_VERSION: context.packageVersion,
        SCRIBE_LAUNCHER_PACKAGE_ROOT: context.packageRoot
      }
    });
  }

  let binary: string;

  try {
    binary = (await resolveNativeBinary()).path;
  } catch (error) {
    throw new Error(
      `${errorMessage(error)} Reinstall @scribe-sdk/cli so npm can install the matching optional platform package.`
    );
  }

  return spawnInherited(binary, args, {
    ...env,
    SCRIBE_ENGINE_ENTRY: resolve(
      packageRoot,
      "dist/engine.mjs"
    ),
    SCRIBE_CLI_PACKAGE_ROOT: packageRoot,
    SCRIBE_EXECUTION_SOURCE: context.source,
    SCRIBE_INVOKED_BINARY: context.invokedBinary
  });
}

export function isDirectInvocation(
  argv1: string | undefined = process.argv[1],
  currentModulePath: string = modulePath
): boolean {
  if (argv1 === undefined) {
    return false;
  }

  try {
    return (
      realpathSync.native(argv1) ===
      realpathSync.native(currentModulePath)
    );
  } catch {
    return (
      resolve(argv1) ===
      resolve(currentModulePath)
    );
  }
}

function spawnInherited(
  command: string,
  args: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>
): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, [...args], {
      cwd: process.cwd(),
      env: { ...env },
      stdio: "inherit",
      shell: false
    });

    const forward = (signal: NodeJS.Signals) => {
      if (
        child.exitCode === null &&
        child.signalCode === null
      ) {
        child.kill(signal);
      }
    };

    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");

    const cleanup = () => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };

    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    child.once("error", (error) => {
      cleanup();
      reject(error);
    });

    child.once("exit", (code, signal) => {
      cleanup();

      resolveExit(
        code ??
          (
            signal === "SIGINT"
              ? 130
              : signal === "SIGTERM"
                ? 143
                : 1
          )
      );
    });
  });
}

function native(
  prefix: string,
  suffix: string | undefined,
  binary: string
): NativeSelection {
  const name =
    suffix === undefined
      ? prefix
      : `${prefix}${suffix}`;

  return {
    packageName: `@scribe-sdk/${name}`,
    binary
  };
}

function detectLibc(): "gnu" | "musl" {
  const report = process.report?.getReport();

  if (
    report !== undefined &&
    "header" in report
  ) {
    const header = object(report.header);

    if (
      typeof header.glibcVersionRuntime === "string"
    ) {
      return "gnu";
    }
  }

  return "musl";
}

function object(
  value: unknown
): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError("Expected an object.");
  }

  return Object.fromEntries(
    Object.entries(value)
  );
}

function requiredString(
  value: unknown,
  name: string
): string {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new TypeError(
      `${name} must be a string.`
    );
  }

  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

if (isDirectInvocation()) {
  void runBootstrap().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `Scribe failed: ${errorMessage(error)}\n`
      );

      process.exitCode = 1;
    }
  );
}
