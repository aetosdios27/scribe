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

export function currentNativePackage() {
  if (
    process.platform === "darwin" &&
    (process.arch === "x64" || process.arch === "arm64")
  ) {
    return `@scribe-sdk/cli-darwin-${process.arch}`;
  }

  if (
    process.platform === "win32" &&
    (process.arch === "x64" || process.arch === "arm64")
  ) {
    return `@scribe-sdk/cli-win32-${process.arch}-msvc`;
  }

  if (
    process.platform === "linux" &&
    (process.arch === "x64" || process.arch === "arm64")
  ) {
    const report = process.report?.getReport();
    const gnu =
      report !== undefined &&
      "header" in report &&
      typeof report.header === "object" &&
      report.header !== null &&
      "glibcVersionRuntime" in report.header;
    return `@scribe-sdk/cli-linux-${process.arch}-${gnu ? "gnu" : "musl"}`;
  }

  throw new Error(
    `Scribe does not provide a native CLI for ${process.platform}/${process.arch}.`
  );
}

export function normalizeRepositoryPath(path) {
  return path.replaceAll("\\", "/");
}
