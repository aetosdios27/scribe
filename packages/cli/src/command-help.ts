export const initHelp = `Create an empty, source-owned content launchpad.

Usage
  scribe init [options]

Examples
  scribe init --dry-run
  scribe init
  scribe init --with-assets
  scribe init --content-dir posts --yes

Options
  --content-dir <path>  Use one repository-relative content directory.
  --with-assets        Also create content/assets.
  --dry-run            Print the plan without writing anything.
  --yes                Create the reported directories without confirmation.
  -h, --help           Show this command help.
`;

export const integrateHelp = `Integrate Scribe deliberately into an existing React project.

Usage
  scribe integrate [options]

Examples
  scribe integrate --dry-run
  scribe integrate
  scribe integrate --mode foundation --yes

Options
  --dry-run       Inspect and print the plan without installing or writing files.
  --mode <mode>   Select foundation, default, or tailwind styling.
  --yes           Apply the reported plan without an interactive confirmation.
  -h, --help      Show this command help.
`;

export const importHelp = `Import stories from an official Medium export ZIP.

Usage
  scribe import <medium-export.zip> [options]

Examples
  scribe import ~/Downloads/medium-export.zip --dry-run
  scribe import ~/Downloads/medium-export.zip

Options
  --into <directory>       Choose a repository-relative article directory.
  --include-drafts         Import unpublished Medium drafts.
  --include-responses      Import response-shaped entries Medium does not label.
  --no-download-assets     Keep remote Medium image URLs.
  --dry-run                Inspect the import without network or file changes.
  --yes                    Accept safe defaults and the final write confirmation.
  -h, --help               Show this command help.
`;

export const studioHelp = `Open Scribe's local, source-authoritative MDX Studio.

Usage
  scribe studio <article.mdx> [options]

Examples
  scribe studio ./content/article.mdx
  scribe studio ./content/article.mdx --mode foundation --no-open

Options
  --mode <mode>     Override detected foundation, default, or tailwind CSS.
  --host-css <path> Load one explicit local host stylesheet.
  --port <number>   Require one specific loopback port.
  --no-open         Do not open the system browser automatically.
  -h, --help        Show this command help.

Without --port, Studio starts at 4317 and advances to the next available port.
`;
