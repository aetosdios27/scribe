import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";

const defaultExecutable = "/usr/bin/helium";
const executable = process.env.SCRIBE_HELIUM_EXECUTABLE ?? defaultExecutable;
const requireHelium = process.argv.includes("--require-helium");
const playwrightArguments = process.argv.slice(2).filter((argument) => argument !== "--require-helium");

try {
  await access(executable);
} catch {
  const message = requireHelium
    ? `Helium is required for release visual verification but was not found at ${executable}.\n`
    : `Helium visual tests skipped: executable not found at ${executable}. Portable browser tests remain available through \`bun run test:browser\`.\n`;
  (requireHelium ? process.stderr : process.stdout).write(message);
  process.exit(requireHelium ? 1 : 0);
}

const result = spawnSync(
  process.execPath,
  ["./node_modules/@playwright/test/cli.js", "test", "--config", "playwright.helium.config.ts", ...playwrightArguments],
  {
    cwd: process.cwd(),
    env: { ...process.env, SCRIBE_HELIUM_EXECUTABLE: executable },
    stdio: "inherit"
  }
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
