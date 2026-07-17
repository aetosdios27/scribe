import { tmpdir } from "node:os";
import { join } from "node:path";

export function executable(name, platform = process.platform) {
  return platform === "win32" && ["npm", "npx"].includes(name) ? `${name}.cmd` : name;
}

export function packageBin(directory, name, platform = process.platform) {
  return join(directory, "node_modules", ".bin", platform === "win32" ? `${name}.cmd` : name);
}

export function releaseCacheDirectory() {
  return join(tmpdir(), "scribe-npm-cache");
}

export function requiresCommandShell(command, platform = process.platform) {
  return platform === "win32" && command.toLowerCase().endsWith(".cmd");
}

export function normalizeRepositoryPath(path) {
  return path.replaceAll("\\", "/");
}
