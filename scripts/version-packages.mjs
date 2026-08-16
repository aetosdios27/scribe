import { spawnSync } from "node:child_process";

run("bunx", ["changeset", "version"]);
run("bun", ["install"]);
await alignRustCrate();

async function alignRustCrate() {
  // The release job that runs this script does not install a Rust
  // toolchain, so keep Cargo.toml and Cargo.lock in sync with plain
  // text edits instead of shelling out to `cargo`. scribe-cli is the
  // workspace's only member and a private, unpublished path package,
  // so its version stamp is not referenced anywhere else in either
  // file.
  const { readFile, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const root = process.cwd();

  const cli = JSON.parse(await readFile(join(root, "packages/cli/package.json"), "utf8"));
  const version = cli.version;

  const cargoTomlPath = join(root, "Cargo.toml");
  const cargoToml = await readFile(cargoTomlPath, "utf8");
  const updatedCargoToml = cargoToml.replace(
    /^version = "[^"]+"$/mu,
    `version = "${version}"`
  );
  if (updatedCargoToml === cargoToml) {
    throw new Error("Could not find the workspace package version in Cargo.toml.");
  }
  await writeFile(cargoTomlPath, updatedCargoToml);

  const cargoLockPath = join(root, "Cargo.lock");
  const cargoLock = await readFile(cargoLockPath, "utf8");
  const updatedCargoLock = cargoLock.replace(
    /(name = "scribe-cli"\nversion = )"[^"]+"/u,
    `$1"${version}"`
  );
  if (updatedCargoLock === cargoLock) {
    throw new Error("Could not find the scribe-cli entry in Cargo.lock.");
  }
  await writeFile(cargoLockPath, updatedCargoLock);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "inherit"
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${result.status ?? "unknown"}`);
  }
}