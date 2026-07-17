import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { executable, releaseCacheDirectory, requiresCommandShell } from "./lib/platform.mjs";

const root = process.cwd();
const output = join(root, ".scribe-release");
const dryRun = process.argv.includes("--dry-run");
const packageDirectories = ["mdx", "react", "styles", "cli"];

await mkdir(output, { recursive: true });

for (const directory of packageDirectories) {
  const args = ["pack", "--json", "--cache", releaseCacheDirectory()];
  if (dryRun) args.push("--dry-run");
  else args.push("--pack-destination", output);

  const command = executable("npm");
  const result = spawnSync(command, args, {
    cwd: join(root, "packages", directory),
    encoding: "utf8",
    shell: requiresCommandShell(command),
    stdio: ["ignore", "pipe", "inherit"]
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  process.stdout.write(result.stdout);
}
