const RESET = "\u001B[0m";
const DEFAULT_FOREGROUND = "\u001B[39m";
const DEFAULT_BACKGROUND = "\u001B[49m";
const LOWER_HALF_BLOCK = "▄";

const START = [0x16, 0x29, 0x6b] as const;
const MIDDLE = [0x2b, 0x52, 0xc9] as const;
const END = [0x50, 0x83, 0xe6] as const;
const WHITE = [0xff, 0xff, 0xff] as const;

const logoGrid: boolean[][] = [
  [false, false, true, true, false, true, true, true, true, true, true, true, false, true, true, false, false],
  [false, true, false, false, false, true, false, false, false, false, false, false, false, false, false, true, false],
  [false, true, false, false, false, true, false, false, false, false, false, false, false, false, false, true, false],
  [true, true, false, false, false, true, true, true, true, true, true, true, false, false, false, true, true],
  [false, true, false, false, false, false, false, false, false, false, false, true, false, false, false, true, false],
  [false, true, false, false, false, false, false, false, false, false, false, true, false, false, false, true, false],
  [false, false, true, true, false, true, true, true, true, true, true, true, false, true, true, false, false]
];

const accentPixel = { row: -1, col: 16 } as const;
let cachedLogo: string | undefined;

export interface TrueColorEnvironment {
  readonly isTTY: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function getLogoGrid(): boolean[][] {
  return logoGrid.map((row) => [...row]);
}

export function getAccentPixel(): { row: number; col: number } {
  return { ...accentPixel };
}

export function renderLogo(): string {
  cachedLogo ??= renderLogoFromGrid();
  return cachedLogo;
}

export function renderLogoFallback(): string {
  return "{S}";
}

export function supportsTrueColor(): boolean {
  return supportsTrueColorFor({
    isTTY: process.stdout.isTTY === true,
    env: process.env
  });
}

export function supportsTrueColorFor({ isTTY, env }: TrueColorEnvironment): boolean {
  const forceColor = env.FORCE_COLOR;
  if (forceColor !== undefined && forceColor !== "" && forceColor !== "0") return true;
  if ("NO_COLOR" in env) return false;
  if (!isTTY) return false;
  return env.COLORTERM === "truecolor" || env.COLORTERM === "24bit";
}

function renderLogoFromGrid(): string {
  const rowPairs = [
    [-1, 0],
    [1, 2],
    [3, 4],
    [5, 6]
  ] as const;

  return rowPairs.map(([topRow, bottomRow]) => {
    const cells = Array.from({ length: 17 }, (_, col) => {
      const top = pixelColor(topRow, col);
      const bottom = pixelColor(bottomRow, col);
      if (top === undefined && bottom === undefined) {
        return `${DEFAULT_FOREGROUND}${DEFAULT_BACKGROUND} `;
      }
      const background = top === undefined
        ? DEFAULT_BACKGROUND
        : backgroundColor(top);
      const foreground = bottom === undefined
        ? DEFAULT_FOREGROUND
        : foregroundColor(bottom);
      return `${background}${foreground}${LOWER_HALF_BLOCK}`;
    });
    return `${cells.join("")}${RESET}`;
  }).join("\n");
}

function pixelColor(row: number, col: number): readonly [number, number, number] | undefined {
  if (row === accentPixel.row && col === accentPixel.col) return WHITE;
  if (row < 0 || logoGrid[row]?.[col] !== true) return undefined;
  return gradientColor(row, col);
}

function gradientColor(row: number, col: number): readonly [number, number, number] {
  const t = (row + col) / 22;
  return t <= 0.5
    ? lerp(START, MIDDLE, t * 2)
    : lerp(MIDDLE, END, (t - 0.5) * 2);
}

function lerp(
  start: readonly [number, number, number],
  end: readonly [number, number, number],
  amount: number
): [number, number, number] {
  return [
    Math.round(start[0] + (end[0] - start[0]) * amount),
    Math.round(start[1] + (end[1] - start[1]) * amount),
    Math.round(start[2] + (end[2] - start[2]) * amount)
  ];
}

function foregroundColor([red, green, blue]: readonly [number, number, number]): string {
  return `\u001B[38;2;${red};${green};${blue}m`;
}

function backgroundColor([red, green, blue]: readonly [number, number, number]): string {
  return `\u001B[48;2;${red};${green};${blue}m`;
}
