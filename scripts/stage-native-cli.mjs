import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = {
  "x86_64-unknown-linux-gnu": ["linux-x64-gnu", "scribe-cli"],
  "x86_64-unknown-linux-musl": ["linux-x64-musl", "scribe-cli"],
  "aarch64-unknown-linux-gnu": ["linux-arm64-gnu", "scribe-cli"],
  "aarch64-unknown-linux-musl": ["linux-arm64-musl", "scribe-cli"],
  "x86_64-apple-darwin": ["darwin-x64", "scribe-cli"],
  "aarch64-apple-darwin": ["darwin-arm64", "scribe-cli"],
  "x86_64-pc-windows-msvc": ["win32-x64-msvc", "scribe-cli.exe"],
  "aarch64-pc-windows-msvc": ["win32-arm64-msvc", "scribe-cli.exe"]
};

export async function stageNativeCli({ target, source, rootDirectory = root }) {
  const definition = targets[target];
  if (definition === undefined) throw new Error(`Unsupported Rust target ${target}.`);
  const [directory, binaryName] = definition;
  const packageDirectory = join(rootDirectory, "packages/cli/native", directory);
  const destination = join(packageDirectory, binaryName);
  const cli = JSON.parse(await readFile(join(rootDirectory, "packages/cli/package.json"), "utf8"));
  await mkdir(packageDirectory, { recursive: true });
  await copyFile(resolve(source), destination);
  if (process.platform !== "win32") await chmod(destination, 0o755);
  const sha256 = createHash("sha256")
    .update(await readFile(destination))
    .digest("hex");
  const gitSha = process.env.GITHUB_SHA;
  const metadata = {
    package: cli.name,
    version: cli.version,
    target,
    binary: basename(destination),
    sha256,
    ...(typeof gitSha === "string" && /^[0-9a-f]{40}$/iu.test(gitSha)
      ? { gitSha }
      : {})
  };
  await writeFile(join(packageDirectory, "build-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return { destination, metadata };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [target, source] = process.argv.slice(2);
  if (target === undefined || source === undefined) {
    process.stderr.write("Usage: node scripts/stage-native-cli.mjs <rust-target> <binary>\n");
    process.exitCode = 2;
  } else {
    await stageNativeCli({ target, source });
  }
}
