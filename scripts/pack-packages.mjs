import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const output = join(root, ".scribe-release");
const dryRun = process.argv.includes("--dry-run");
const packageDirectories = ["mdx", "react", "styles", "cli"];

await mkdir(output, { recursive: true });

for (const directory of packageDirectories) {
  const args = ["pack", "--json", "--cache", "/tmp/scribe-npm-cache"];
  if (dryRun) args.push("--dry-run");
  else args.push("--pack-destination", output);

  const result = spawnSync("npm", args, {
    cwd: join(root, "packages", directory),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  process.stdout.write(result.stdout);
}
