import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  join,
  relative,
  resolve
} from "node:path";
import { createRequire } from "node:module";

import {
  executable,
  packageBin
} from "./lib/platform.mjs";
import {
  spawnPortableSync
} from "./lib/spawn.mjs";

const requireCliDependency = createRequire(
  new URL(
    "../packages/cli/package.json",
    import.meta.url
  )
);

const {
  strToU8,
  zipSync
} = requireCliDependency("fflate");

const commandTimeoutMilliseconds = 300_000;
const packageManagerInstallTimeoutMilliseconds = 600_000;

const root = process.cwd();
const release = join(
  root,
  ".scribe-release"
);

const manifest = JSON.parse(
  await readFile(
    join(
      root,
      "packages",
      "cli",
      "package.json"
    ),
    "utf8"
  )
);

const version = manifest.version;
const expectedVersionOutput =
  `scribe ${version}`;

const nativePackage =
  currentNativePackage();

const nativeTarballName =
  `${nativePackage.replace(
    "@scribe-sdk/",
    "scribe-sdk-"
  )}-${version}.tgz`;

const directory = await mkdtemp(
  join(
    tmpdir(),
    "scribe portability "
  )
);

const tarballDirectory = join(
  directory,
  "tarballs"
);

const articleDirectory = join(
  directory,
  "articles with spaces",
  "unicode-記事"
);

const results = [];

try {
  await mkdir(
    tarballDirectory,
    {
      recursive: true
    }
  );

  await mkdir(
    articleDirectory,
    {
      recursive: true
    }
  );

  const dependencies = {};

  for (
    const name of [
      "mdx",
      "react",
      "styles",
      "cli"
    ]
  ) {
    const filename =
      `scribe-sdk-${name}-${version}.tgz`;

    await copyFile(
      join(
        release,
        filename
      ),
      join(
        tarballDirectory,
        filename
      )
    );

    dependencies[
      `@scribe-sdk/${name}`
    ] =
      `file:./tarballs/${filename}`;
  }

  await copyFile(
    join(
      release,
      nativeTarballName
    ),
    join(
      tarballDirectory,
      nativeTarballName
    )
  );

  dependencies[nativePackage] =
    `file:./tarballs/${nativeTarballName}`;

  await write(
    join(
      directory,
      "package.json"
    ),
    JSON.stringify(
      {
        name: "scribe-portability-smoke",
        private: true,
        type: "module",
        scripts: {
          "scribe:version":
            "scribe --version"
        },
        dependencies: {
          ...dependencies,
          react: "19.2.7",
          vite: "8.1.3"
        },
        overrides: dependencies
      },
      null,
      2
    )
  );

  const valid = join(
    articleDirectory,
    "valid article.mdx"
  );

  const invalid = join(
    articleDirectory,
    "invalid article.mdx"
  );

  await write(
    valid,
    "# Portable article\r\n\r\n```ts filename=\"src/portable.ts\" lineNumbers highlight=\"1\"\r\nexport const portable = true\r\n```\r\n"
  );

  await write(
    invalid,
    '<Callout variant="warnng">Typo</Callout>\r\n'
  );

  const globalStyle = join(
    directory,
    "src",
    "index.css"
  );

  await write(
    globalStyle,
    "body { margin: 0; }\r\n"
  );

  const mediumExport = join(
    directory,
    "medium export.zip"
  );

  await writeFile(
    mediumExport,
    zipSync({
      "medium-export/posts/2026-07-31_portable-story.html":
        strToU8(
          "<!doctype html><html><head><title>Portable Medium story</title></head><body><article><h1>Portable Medium story</h1><p>Imported through the packed CLI.</p></article></body></html>"
        )
    })
  );

  run(
    executable("bun"),
    ["install"],
    directory
  );

  run(
    executable("bun"),
    [
      "install",
      "--frozen-lockfile"
    ],
    directory
  );

  /*
   * Exercise the actual installed package-bin launchers.
   *
   * This intentionally tests the JS bootstrap rather than bypassing it:
   * package-manager shims are part of the public CLI contract.
   */
  for (
    const command of [
      "scribe",
      "scb"
    ]
  ) {
    const reportedVersion =
      runCli(
        command,
        ["--version"]
      ).stdout.trim();

    assert(
      reportedVersion ===
        expectedVersionOutput,
      `${command} reported '${reportedVersion}'; expected '${expectedVersionOutput}'.`
    );

    runCli(
      command,
      ["--help"]
    );

    runCli(
      command,
      [
        "validate",
        "--help"
      ]
    );
  }

  runCli(
    "scribe",
    [
      "init",
      "--help"
    ]
  );

  runCli(
    "scribe",
    [
      "integrate",
      "--help"
    ]
  );

  runCli(
    "scribe",
    [
      "import",
      "--help"
    ]
  );

  runCli(
    "scribe",
    [
      "studio",
      "--help"
    ]
  );

  runCli(
    "scribe",
    [
      "studio",
      "init",
      "--help"
    ]
  );

  runCli(
    "scribe",
    [
      "update",
      "--help"
    ]
  );

  run(
    executable("bun"),
    [
      "run",
      "scribe:version"
    ],
    directory
  );

  const beforeInitDryRun =
    await snapshotFixtureTree(
      directory
    );

  const dryRun = runCli(
    "scribe",
    [
      "init",
      "--dry-run"
    ]
  );

  assert(
    dryRun.stdout.includes(
      "content/blog"
    ) &&
      dryRun.stdout.includes(
        "No files will be generated."
      ),
    "Init dry run did not describe the empty content launchpad."
  );

  assert(
    JSON.stringify(
      await snapshotFixtureTree(
        directory
      )
    ) ===
      JSON.stringify(
        beforeInitDryRun
      ),
    "Init dry run modified the fixture."
  );

  const beforeInit =
    await snapshotFixtureTree(
      directory,
      new Set([
        "content"
      ])
    );

  runCli(
    "scribe",
    [
      "init",
      "--yes"
    ]
  );

  assert(
    JSON.stringify(
      await snapshotFixtureTree(
        directory,
        new Set([
          "content"
        ])
      )
    ) ===
      JSON.stringify(
        beforeInit
      ),
    "Init changed host files while creating the content launchpad."
  );

  assert(
    (
      await readdir(
        join(
          directory,
          "content",
          "blog"
        )
      )
    ).length === 0,
    "Init generated content instead of leaving the launchpad empty."
  );

  runCli(
    "scribe",
    [
      "init",
      "--yes"
    ]
  );

  const beforeImportDryRun =
    await snapshotFixtureTree(
      directory
    );

  runCli(
    "scribe",
    [
      "import",
      relative(
        directory,
        mediumExport
      ),
      "--into",
      "imported",
      "--dry-run"
    ]
  );

  assert(
    JSON.stringify(
      await snapshotFixtureTree(
        directory
      )
    ) ===
      JSON.stringify(
        beforeImportDryRun
      ),
    "Medium import dry run modified the fixture."
  );

  runCli(
    "scribe",
    [
      "import",
      relative(
        directory,
        mediumExport
      ),
      "--into",
      "imported",
      "--no-download-assets",
      "--yes"
    ]
  );

  const importedArticle = join(
    directory,
    "imported",
    "portable-story.mdx"
  );

  assert(
    (
      await readFile(
        importedArticle,
        "utf8"
      )
    ).includes(
      "Imported through the packed CLI."
    ),
    "Packed CLI did not import the Medium fixture."
  );

  runCli(
    "scribe",
    [
      "validate",
      relative(
        directory,
        importedArticle
      )
    ]
  );

  const beforeIntegrateDryRun =
    await snapshotFixtureTree(
      directory
    );

  const integrateDryRun =
    runCli(
      "scribe",
      [
        "integrate",
        "--dry-run"
      ]
    );

  assert(
    integrateDryRun.stdout.includes(
      "Recommendation"
    ) &&
      integrateDryRun.stdout.includes(
        "Mode    default"
      ),
    "Integrate dry run did not recommend default mode for the raw Vite fixture."
  );

  assert(
    JSON.stringify(
      await snapshotFixtureTree(
        directory
      )
    ) ===
      JSON.stringify(
        beforeIntegrateDryRun
      ),
    "Integrate dry run modified the fixture."
  );

  const usage = runCli(
    "scribe",
    [],
    false
  );

  assert(
    usage.status === 0,
    `scribe without arguments exited ${usage.status}; expected 0.`
  );

  assert(
    usage.stdout.includes(
      "Scribe is not integrated here."
    ),
    "Bare scribe did not report the project integration state."
  );

  const validResult =
    runCli(
      "scribe",
      [
        "validate",
        relative(directory, valid)
      ]
    );

  assert(
    !/\u001B\[/u.test(
      `${validResult.stdout}${validResult.stderr}`
    ),
    "Captured CLI output contained ANSI styling."
  );

  runCli(
    "scribe",
    [
      "validate",
      resolve(valid)
    ]
  );

  runCli(
    "scb",
    [
      "validate",
      relative(
        directory,
        valid
      )
    ]
  );

  const noColor =
    runCli(
      "scribe",
      [
        "validate",
        relative(directory, valid)
      ],
      true,
      {
        NO_COLOR: "1"
      }
    );

  assert(
    !/\u001B\[/u.test(
      `${noColor.stdout}${noColor.stderr}`
    ),
    "NO_COLOR output contained ANSI styling."
  );

  const rejected =
    runCli(
      "scribe",
      [
        "validate",
        relative(
          directory,
          invalid
        )
      ],
      false
    );

  assert(
    rejected.status === 1,
    `Invalid article exited ${rejected.status}; expected 1.`
  );

  assert(
    rejected.stderr.includes(
      "SCB1101"
    ),
    "Invalid article did not report SCB1101."
  );

  assert(
    !/\n\s+at\s/u.test(
      rejected.stderr
    ),
    "Invalid article exposed an internal stack trace."
  );

  for (
    const name of [
      "mdx",
      "react",
      "styles",
      "cli"
    ]
  ) {
    const installed =
      JSON.parse(
        await readFile(
          join(
            directory,
            "node_modules",
            "@scribe-sdk",
            name,
            "package.json"
          ),
          "utf8"
        )
      );

    assert(
      installed.version ===
        version,
      `@scribe-sdk/${name} installed at ${installed.version}; expected ${version}.`
    );
  }

  const installedNative =
    JSON.parse(
      await readFile(
        join(
          directory,
          "node_modules",
          ...nativePackage.split(
            "/"
          ),
          "package.json"
        ),
        "utf8"
      )
    );

  assert(
    installedNative.version ===
      version,
    `${nativePackage} installed at ${installedNative.version}; expected ${version}.`
  );

  await verifyLocalNpmInstall();
  await verifyGlobalInstalls();
} finally {
  await mkdir(
    release,
    {
      recursive: true
    }
  );

  await writeFile(
    join(
      release,
      `portability-${process.platform}.json`
    ),
    `${JSON.stringify(
      {
        platform:
          process.platform,
        architecture:
          process.arch,
        version,
        temporaryConsumer:
          "removed",
        results
      },
      null,
      2
    )}\n`
  );

  await rm(
    directory,
    {
      recursive: true,
      force: true
    }
  );
}

process.stdout.write(
  `Packed CLI portability smoke passed on ${process.platform} for ${version}.\n`
);

function runCli(
  command,
  args,
  requireSuccess = true,
  env = {}
) {
  return run(
    packageBin(
      directory,
      command
    ),
    args,
    directory,
    requireSuccess,
    env
  );
}

function run(
  command,
  args,
  cwd,
  requireSuccess = true,
  env = {},
  timeoutMilliseconds = commandTimeoutMilliseconds
) {
  const renderedCommand =
    [
      command,
      ...args
    ].join(" ");

  process.stdout.write(
    `Running portability command: ${renderedCommand}\n`
  );

  const result =
    spawnPortableSync(
      command,
      args,
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:
            "1",
          ...env
        },
        timeout: timeoutMilliseconds
      }
    );

  if (result.error) throw result.error;

  results.push({
    command:
      renderedCommand,
    status:
      result.status,
    stdout:
      result.stdout?.trim() ??
      "",
    stderr:
      result.stderr?.trim() ??
      ""
  });

  if (
    requireSuccess &&
    result.status !== 0
  ) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}:\n${result.stdout}\n${result.stderr}`
    );
  }

  return result;
}

async function verifyLocalNpmInstall() {
  const npmDirectory = join(
    directory,
    "npm-local"
  );

  await mkdir(
    npmDirectory,
    {
      recursive: true
    }
  );

  await write(
    join(
      npmDirectory,
      "package.json"
    ),
    JSON.stringify(
      {
        name:
          "scribe-portability-npm-smoke",
        private: true,
        dependencies: {
          "@scribe-sdk/cli":
            "file:../tarballs/scribe-sdk-cli-" +
            version +
            ".tgz",

          "@scribe-sdk/mdx":
            "file:../tarballs/scribe-sdk-mdx-" +
            version +
            ".tgz",

          "@scribe-sdk/react":
            "file:../tarballs/scribe-sdk-react-" +
            version +
            ".tgz",

          "@scribe-sdk/styles":
            "file:../tarballs/scribe-sdk-styles-" +
            version +
            ".tgz",

          [nativePackage]:
            "file:../tarballs/" +
            nativeTarballName,

          react:
            "19.2.7",

          "react-dom":
            "19.2.7"
        }
      },
      null,
      2
    )
  );

  run(
    executable("npm"),
    [
      "install",
      "--no-audit",
      "--no-fund"
    ],
    npmDirectory,
    true, {}, packageManagerInstallTimeoutMilliseconds
  );

  const npxVersion =
    run(
      executable("npx"),
      ["--no-install", "scribe", "--version"],
      npmDirectory
    ).stdout.trim();

  assert(
    npxVersion ===
      expectedVersionOutput,
    `npx scribe reported ${npxVersion}; expected ${expectedVersionOutput}.`
  );

  const npmVersion =
    run(
      packageBin(
        npmDirectory,
        "scribe"
      ),
      ["--version"],
      npmDirectory
    ).stdout.trim();

  assert(
    npmVersion ===
      expectedVersionOutput,
    `Local npm scribe reported ${npmVersion}; expected ${expectedVersionOutput}.`
  );

  const npmAliasVersion =
    run(
      packageBin(
        npmDirectory,
        "scb"
      ),
      ["--version"],
      npmDirectory
    ).stdout.trim();

  assert(
    npmAliasVersion ===
      expectedVersionOutput,
    `Local npm scb reported ${npmAliasVersion}; expected ${expectedVersionOutput}.`
  );
}

async function verifyGlobalInstalls() {
  const packageTarballs =
    [
      "mdx",
      "react",
      "styles",
      "cli"
    ].map(
      (name) =>
        join(
          tarballDirectory,
          `scribe-sdk-${name}-${version}.tgz`
        )
    );

  packageTarballs.push(
    join(
      tarballDirectory,
      nativeTarballName
    )
  );

  const npmPrefix =
    join(
      directory,
      "npm-global"
    );

  run(
    executable("npm"),
    [
      "install",
      "--global",
      "--prefix",
      npmPrefix,
      "--no-audit",
      "--no-fund",
      ...packageTarballs
    ],
    directory,
    true, {}, packageManagerInstallTimeoutMilliseconds
  );

  const npmScribe =
    await findExecutable(
      process.platform ===
        "win32"
        ? npmPrefix
        : join(
            npmPrefix,
            "bin"
          ),
      "scribe"
    );

  const npmVersion =
    run(
      npmScribe,
      ["--version"],
      directory
    ).stdout.trim();

  assert(
    npmVersion ===
      expectedVersionOutput,
    `Global npm scribe reported ${npmVersion}; expected ${expectedVersionOutput}.`
  );

  const npmAlias =
    await findExecutable(
      process.platform ===
        "win32"
        ? npmPrefix
        : join(
            npmPrefix,
            "bin"
          ),
      "scb"
    );

  const npmAliasVersion =
    run(
      npmAlias,
      ["--version"],
      directory
    ).stdout.trim();

  assert(
    npmAliasVersion ===
      expectedVersionOutput,
    `Global npm scb reported ${npmAliasVersion}; expected ${expectedVersionOutput}.`
  );

  const npmGlobalBare =
    run(
      npmScribe,
      [],
      directory,
      false
    );

  assert(
    npmGlobalBare.status === 0,
    `Global npm scribe without arguments exited ${npmGlobalBare.status}; expected 0.`
  );

  assert(
    npmGlobalBare.stdout.includes(
      "Scribe is not integrated here."
    ),
    "Global npm scribe did not delegate to print the project integration state."
  );

  const bunHome = join(
    directory,
    "bun-global"
  );

  const bunEnv = {
    BUN_INSTALL:
      bunHome
  };

  run(
    executable("bun"),
    [
      "add",
      "--global",
      ...packageTarballs
    ],
    directory,
    true,
    bunEnv
  );

  const bunBinDirectory =
    run(
      executable("bun"),
      [
        "pm",
        "bin",
        "-g"
      ],
      directory,
      true,
      bunEnv
    ).stdout.trim();

  const bunScribe =
    await findExecutable(
      bunBinDirectory,
      "scribe"
    );

  const bunVersion =
    run(
      bunScribe,
      ["--version"],
      directory,
      true,
      bunEnv
    ).stdout.trim();

  assert(
    bunVersion ===
      expectedVersionOutput,
    `Global Bun scribe reported ${bunVersion}; expected ${expectedVersionOutput}.`
  );

  const bunAlias =
    await findExecutable(
      bunBinDirectory,
      "scb"
    );

  const bunAliasVersion =
    run(
      bunAlias,
      ["--version"],
      directory,
      true,
      bunEnv
    ).stdout.trim();

  assert(
    bunAliasVersion ===
      expectedVersionOutput,
    `Global Bun scb reported ${bunAliasVersion}; expected ${expectedVersionOutput}.`
  );

  const bunGlobalBare =
    run(
      bunScribe,
      [],
      directory,
      false,
      bunEnv
    );

  assert(
    bunGlobalBare.status === 0,
    `Global Bun scribe without arguments exited ${bunGlobalBare.status}; expected 0.`
  );

  assert(
    bunGlobalBare.stdout.includes(
      "Scribe is not integrated here."
    ),
    "Global Bun scribe did not delegate to print the project integration state."
  );
}

async function findExecutable(
  directory,
  name
) {
  for (
    const candidate of
      process.platform ===
      "win32"
        ? [
            `${name}.exe`,
            `${name}.cmd`,
            name
          ]
        : [
            name
          ]
  ) {
    const path = join(
      directory,
      candidate
    );

    try {
      await access(path);
      return path;
    } catch {
      // Continue through platform shims.
    }
  }

  throw new Error(
    `Could not find ${name} in ${directory}.`
  );
}

async function write(
  path,
  content
) {
  await mkdir(
    dirname(path),
    {
      recursive: true
    }
  );

  await writeFile(
    path,
    content
  );
}

async function snapshotFixtureTree(
  directory,
  extraExcluded = new Set()
) {
  const excluded =
    new Set([
      "node_modules",
      "tarballs",
      ...extraExcluded
    ]);

  const snapshot = [];

  async function visit(
    current,
    prefix = ""
  ) {
    const entries =
      (
        await readdir(
          current,
          {
            withFileTypes:
              true
          }
        )
      ).sort(
        (
          left,
          right
        ) =>
          left.name.localeCompare(
            right.name
          )
      );

    for (
      const entry of entries
    ) {
      if (
        prefix === "" &&
        excluded.has(
          entry.name
        )
      ) {
        continue;
      }

      const relativePath =
        prefix === ""
          ? entry.name
          : `${prefix}/${entry.name}`;

      const path = join(
        current,
        entry.name
      );

      if (
        entry.isDirectory()
      ) {
        snapshot.push(
          `directory:${relativePath}`
        );

        await visit(
          path,
          relativePath
        );
      } else {
        snapshot.push(
          `file:${relativePath}:${(
            await readFile(path)
          ).toString(
            "base64"
          )}`
        );
      }
    }
  }

  await visit(directory);

  return snapshot;
}

function currentNativePackage() {
  if (
    process.platform ===
      "darwin" &&
    (
      process.arch ===
        "x64" ||
      process.arch ===
        "arm64"
    )
  ) {
    return `@scribe-sdk/cli-darwin-${process.arch}`;
  }

  if (
    process.platform ===
      "win32" &&
    (
      process.arch ===
        "x64" ||
      process.arch ===
        "arm64"
    )
  ) {
    return `@scribe-sdk/cli-win32-${process.arch}-msvc`;
  }

  if (
    process.platform ===
      "linux" &&
    (
      process.arch ===
        "x64" ||
      process.arch ===
        "arm64"
    )
  ) {
    const report =
      process.report?.getReport();

    const gnu =
      report !== undefined &&
      "header" in report &&
      typeof report.header ===
        "object" &&
      report.header !== null &&
      "glibcVersionRuntime" in
        report.header;

    return `@scribe-sdk/cli-linux-${process.arch}-${gnu ? "gnu" : "musl"}`;
  }

  throw new Error(
    `No packed native CLI target for ${process.platform}/${process.arch}.`
  );
}

function assert(
  condition,
  message
) {
  if (!condition) {
    throw new Error(
      message
    );
  }
}
