import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const publicPackages = ["styles", "react", "mdx", "cli"];

for (const directory of publicPackages) {
  const label = `@scribe-sdk/${directory}`;
  process.stdout.write(`Auditing ${label} production dependencies...\n`);
  const result = spawnSync("bun", ["audit", "--production"], {
    cwd: join(root, "packages", directory),
    stdio: "inherit"
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(`${label} production dependency audit failed.\n`);
    process.exit(result.status ?? 1);
  }
}

process.stdout.write("All public Scribe package production dependency audits passed.\n");
