import { access, chmod, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  executable,
  releaseCacheDirectory,
  requiresCommandShell
} from "./lib/platform.mjs";

const root = process.cwd();
const output = join(root, ".scribe-release");
const dryRun = process.argv.includes("--dry-run");

const packageDirectories = [
  ["packages", "mdx"],
  ["packages", "react"],
  ["packages", "styles"],
  ["packages", "cli"],
  ...[
    "linux-x64-gnu",
    "linux-x64-musl",
    "linux-arm64-gnu",
    "linux-arm64-musl",
    "darwin-x64",
    "darwin-arm64",
    "win32-x64-msvc",
    "win32-arm64-msvc"
  ].map((directory) => [
    "packages",
    "cli-native",
    directory
  ])
];

const nativePackageDirectories =
  packageDirectories.slice(4);

const hostSupportsPosixModes =
  process.platform !== "win32";

/**
 * GitHub artifact archives do not reliably preserve Unix executable bits.
 *
 * Native binaries are built and staged with the correct mode in their
 * platform jobs, but after an upload/download artifact round-trip they may
 * arrive as ordinary 0644 files.
 *
 * Restore the executable bit immediately before packaging on POSIX hosts.
 * Windows does not expose meaningful POSIX executable mode semantics, so
 * mode normalization and validation are intentionally skipped there.
 */
async function prepareNativePackage(directory) {
  const packageRoot = join(
    root,
    ...directory
  );

  const packageName =
    directory.at(-1) ?? "";

  const windowsPackage =
    packageName.startsWith("win32");

  const binary = join(
    packageRoot,
    "bin",
    windowsPackage
      ? "scribe-cli.exe"
      : "scribe-cli"
  );

  const metadata = join(
    packageRoot,
    "build-metadata.json"
  );

  await Promise.all([
    access(binary),
    access(metadata)
  ]);

  if (
    windowsPackage ||
    !hostSupportsPosixModes
  ) {
    return;
  }

  let details = await stat(binary);

  if ((details.mode & 0o111) === 0) {
    await chmod(binary, 0o755);
    details = await stat(binary);
  }

  if ((details.mode & 0o111) === 0) {
    throw new Error(
      `${binary} could not be made executable.`
    );
  }
}

await Promise.all(
  nativePackageDirectories.map(
    prepareNativePackage
  )
);

await mkdir(output, {
  recursive: true
});

for (const directory of packageDirectories) {
  const args = [
    "pack",
    "--json",
    "--cache",
    releaseCacheDirectory()
  ];

  if (dryRun) {
    args.push("--dry-run");
  } else {
    args.push(
      "--pack-destination",
      output
    );
  }

  const command = executable("npm");

  const result = spawnSync(
    command,
    args,
    {
      cwd: join(
        root,
        ...directory
      ),
      encoding: "utf8",
      shell:
        requiresCommandShell(command),
      stdio: [
        "ignore",
        "pipe",
        "inherit"
      ]
    }
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(
      result.status ?? 1
    );
  }

  process.stdout.write(
    result.stdout ?? ""
  );
}
