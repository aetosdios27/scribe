import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("cross-platform release scripts", () => {
  it("uses OS-owned temporary storage and Windows command shims", async () => {
    const platform = await source("scripts/lib/platform.mjs");
    const pack = await source("scripts/pack-packages.mjs");
    const consumers = await source("scripts/test-packed-consumers.mjs");
    const portability = await source("scripts/check-portability.mjs");
    const fixedTemp = ["/tmp", "/"].join("");

    expect(platform).toContain('import { tmpdir } from "node:os"');
    expect(platform).toContain('platform === "win32"');
    expect(platform).toContain('`${name}.cmd`');
    expect(platform).toContain("requiresCommandShell");
    expect(platform).toContain("normalizeRepositoryPath");
    expect(portability).toContain("normalizeRepositoryPath(relative(root, path))");
    expect(pack).not.toContain(fixedTemp);
    expect(consumers).not.toContain(fixedTemp);
  });

  it("inspects npm archives without requiring a platform tar executable", async () => {
    const inspect = await source("scripts/inspect-tarballs.mjs");
    expect(inspect).toContain('from "./lib/tarball.mjs"');
    expect(inspect).not.toMatch(/execFileSync\(["']tar["']/u);
  });

  it("smoke-tests CRLF, Unicode, spaces, absolute paths, and CLI status codes", async () => {
    const smoke = await source("scripts/test-portable-cli.mjs");
    expect(smoke).toContain("unicode-記事");
    expect(smoke).toContain("\\r\\n");
    expect(smoke).toContain("relative(directory, valid)");
    expect(smoke).toContain("resolve(valid)");
    expect(smoke).toContain("usage.status === 2");
    expect(smoke).toContain("rejected.status === 1");
  });

  it("keeps missing Helium optional for contributors but fatal for release verification", async () => {
    const wrapper = await source("scripts/run-helium-visual.mjs");
    expect(wrapper).toContain('process.argv.includes("--require-helium")');
    expect(wrapper).toContain("Helium is required for release visual verification");
    expect(wrapper).toContain("process.exit(requireHelium ? 1 : 0)");
  });
});

async function source(path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}
