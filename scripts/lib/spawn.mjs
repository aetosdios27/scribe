import crossSpawn from "cross-spawn";

import {
  requiresCommandShell
} from "./platform.mjs";

export function spawnPortableSync(
  command,
  args,
  options = {}
) {
  return crossSpawn.sync(
    command,
    args,
    {
      ...options,
      shell: requiresCommandShell(command)
    }
  );
}
