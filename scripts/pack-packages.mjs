import { access, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { executable, releaseCacheDirectory, requiresCommandShell } from "./lib/platform.mjs";

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
  ].map((directory) => ["packages", "cli-native", directory])
];
const nativePackageDirectories = packageDirectories.slice(4);

await Promise.all(nativePackageDirectories.flatMap((directory) => {
  const packageRoot = join(root, ...directory);
  const windows = directory.at(-1)?.startsWith("win32") === true;
  const binary = join(packageRoot, "bin", windows ? "scribe-cli.exe" : "scribe-cli");
  const metadata = join(packageRoot, "build-metadata.json");
  return [
    access(binary),
    access(metadata),
    ...windows ? [] : [
      stat(binary).then((details) => {
        if ((details.mode & 0o111) === 0) {
          throw new Error(`${binary} is not executable.`);
        }
      })
    ]
  ];
}));

await mkdir(output, { recursive: true });

for (const directory of packageDirectories) {
  const args = ["pack", "--json", "--cache", releaseCacheDirectory()];
  if (dryRun) args.push("--dry-run");
  else args.push("--pack-destination", output);

  const command = executable("npm");
  const result = spawnSync(command, args, {
    cwd: join(root, ...directory),
    encoding: "utf8",
    shell: requiresCommandShell(command),
    stdio: ["ignore", "pipe", "inherit"]
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  process.stdout.write(result.stdout);
}
