import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";

export function spawnPortableSync(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding
): SpawnSyncReturns<string>;
