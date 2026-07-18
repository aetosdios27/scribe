import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

for (const fixture of ["tailwind-v3", "tailwind-v4"]) {
  const result = spawnSync("bun", ["run", "build"], {
    cwd: fileURLToPath(new URL(`../tests/integration/${fixture}/`, import.meta.url)),
    encoding: "utf8",
    shell: false,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Built Tailwind style fixtures from ${root}.`);
