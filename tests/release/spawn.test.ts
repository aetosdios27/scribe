import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { spawnPortableSync } from "../../scripts/lib/spawn.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("portable command spawning", () => {
  it("preserves arguments containing spaces without a shell", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scribe spawn "));
    temporaryDirectories.push(directory);

    const value = join(directory, "nested path");
    const result = spawnPortableSync(
      process.execPath,
      ["-e", "process.stdout.write(process.argv[1])", value],
      { encoding: "utf8" }
    );

    expect(result.error).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(value);
  });
});
