import crossSpawn from "cross-spawn";

export function spawnPortableSync(command, args, options = {}) {
  return crossSpawn.sync(command, args, { ...options, shell: false });
}
