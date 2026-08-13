const blue = "\u001B[94m";
const reset = "\u001B[0m";

export interface ScribeLogoOptions {
  readonly color: boolean;
  readonly detailed: boolean;
}

export function renderScribeLogo(version: string, options: ScribeLogoOptions): string {
  if (!options.detailed) {
    return `${paint("{S}", options.color)} Scribe · ${version}\n`;
  }

  const mark = [
    "╭──────────╮",
    "│          │",
    "│   {S}    │",
    "│          │",
    "╰──────────╯"
  ];
  const wordmark = [
    "",
    "S C R I B E",
    `Publishing SDK · ${version}`,
    "",
    ""
  ];

  return `${mark.map((line, index) => `${paint(line, options.color)}  ${wordmark[index]}`).join("\n")}\n`;
}

function paint(value: string, enabled: boolean): string {
  return enabled ? `${blue}${value}${reset}` : value;
}
