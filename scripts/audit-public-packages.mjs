import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = join(import.meta.dirname, "..");

export const publicPackages = Object.freeze([
  "styles",
  "react",
  "mdx",
  "cli"
]);

const commandTimeoutMilliseconds = 120_000;

const acceptedAdvisories = new Map([
  [
    1124022,
    "Monaco 0.56.0 pins DOMPurify 3.4.8; Scribe does not enable custom-element sanitizer hooks."
  ],
  [
    1124233,
    "Monaco 0.56.0 pins DOMPurify 3.4.8; Scribe does not expose DOMPurify setConfig or mutable sanitizer policy."
  ],
  [
    1124234,
    "Monaco 0.56.0 pins DOMPurify 3.4.8; Scribe does not use DOMPurify Trusted Types configuration."
  ],
  [
    1138538,
    "Monaco 0.56.0 pins DOMPurify 3.4.8; the advisory requires IN_PLACE sanitization with hook-driven element removal, which Scribe does not configure or expose."
  ],
  [
    1138115,
    "Scribe resolves js-yaml 4.3.0 through @mdxeditor/editor. CVE-2026-59870 affects js-yaml >=5.0.0 <5.2.1 and is documented upstream as a v5 regression; the vulnerable !!omap implementation is not present in the 4.x line."
  ]
]);

export async function auditPublicPackages() {
  const dependencies = {};

  for (const directory of publicPackages) {
    const manifest = JSON.parse(
      await readFile(
        join(root, "packages", directory, "package.json"),
        "utf8"
      )
    );

    for (const group of [
      manifest.dependencies ?? {},
      manifest.peerDependencies ?? {}
    ]) {
      for (const [name, version] of Object.entries(group)) {
        if (name.startsWith("@scribe-sdk/")) {
          continue;
        }

        if (
          dependencies[name] !== undefined &&
          dependencies[name] !== version
        ) {
          throw new Error(
            `Conflicting production dependency ranges for ${name}: ${dependencies[name]} and ${version}.`
          );
        }

        dependencies[name] = version;
      }
    }
  }

  const auditDirectory = await mkdtemp(
    join(tmpdir(), "scribe-public-audit-")
  );

  try {
    await writeFile(
      join(auditDirectory, "package.json"),
      `${JSON.stringify(
        {
          name: "scribe-public-runtime-audit",
          version: "0.0.0",
          private: true,
          dependencies
        },
        null,
        2
      )}\n`
    );

    run(auditDirectory, "npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund"
    ]);

    const installedTree = runJson(
      auditDirectory,
      "npm",
      ["ls", "--all", "--json"]
    );

    const advisoryRequest = collectPackageVersions(installedTree);

    const response = await fetch(
      "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify(advisoryRequest),
        signal: AbortSignal.timeout(commandTimeoutMilliseconds)
      }
    );

    if (!response.ok) {
      throw new Error(
        `npm bulk advisory request failed with HTTP ${response.status}.`
      );
    }

    const report = decodeAuditResponse(
      Buffer.from(await response.arrayBuffer())
    );

    const advisories = Object.entries(report).flatMap(
      ([name, matches]) =>
        matches.map((advisory) => ({
          ...advisory,
          name
        }))
    );

    const blockingAdvisories = advisories.filter(
      ({ id }) => !acceptedAdvisories.has(id)
    );

    for (const advisory of advisories) {
      const accepted = acceptedAdvisories.get(advisory.id);

      if (accepted !== undefined) {
        process.stdout.write(
          `Accepted ${advisory.severity} advisory ${advisory.id} for ${advisory.name}: ${accepted}\n`
        );
      }
    }

    if (blockingAdvisories.length > 0) {
      for (const advisory of blockingAdvisories) {
        process.stderr.write(
          `${advisory.severity ?? "unknown"}: ${advisory.name} [${advisory.id}] — ${
            advisory.title ??
            advisory.url ??
            "known vulnerability"
          }\n`
        );
      }

      throw new Error(
        `Production dependency audit found ${blockingAdvisories.length} unaccepted advisories.`
      );
    }

    process.stdout.write(
      `Audited ${Object.keys(advisoryRequest).length} installed production dependencies across all public Scribe packages.\n`
    );
  } finally {
    await rm(auditDirectory, {
      recursive: true,
      force: true
    });
  }
}

export function decodeAuditResponse(bytes) {
  const decoded =
    bytes[0] === 0x1f && bytes[1] === 0x8b
      ? gunzipSync(bytes)
      : bytes;

  return JSON.parse(decoded.toString("utf8"));
}

function runJson(directory, command, args) {
  const result = spawnSync(command, args, {
    cwd: directory,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: commandTimeoutMilliseconds
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(" ")} exited with code ${result.status ?? 1}.`);
  }

  return JSON.parse(result.stdout);
}

function collectPackageVersions(tree) {
  const versions = new Map();

  const visit = (node) => {
    for (const [name, dependency] of Object.entries(
      node.dependencies ?? {}
    )) {
      if (typeof dependency.version === "string") {
        const values = versions.get(name) ?? new Set();

        values.add(dependency.version);
        versions.set(name, values);
      }

      visit(dependency);
    }
  };

  visit(tree);

  return Object.fromEntries(
    [...versions].map(([name, values]) => [
      name,
      [...values].sort()
    ])
  );
}

function run(directory, command, args) {
  const result = spawnSync(command, args, {
    cwd: directory,
    stdio: "inherit",
    timeout: commandTimeoutMilliseconds
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${result.status ?? 1}.`);
  }
}

if (
  process.env["npm_lifecycle_event"] === "release:audit" ||
  (
    process.argv[1] &&
    fileURLToPath(import.meta.url) === resolve(process.argv[1])
  )
) {
  await auditPublicPackages();
}
