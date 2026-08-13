import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import {
  getAccentPixel,
  getLogoGrid,
  renderLogo,
  renderLogoFallback,
  supportsTrueColorFor
} from "./logo.js";

const filledCoordinates = new Set([
  "0:2", "0:3", "0:5", "0:6", "0:7", "0:8", "0:9", "0:10", "0:11", "0:13", "0:14",
  "1:1", "1:5", "1:15",
  "2:1", "2:5", "2:15",
  "3:0", "3:1", "3:5", "3:6", "3:7", "3:8", "3:9", "3:10", "3:11", "3:15", "3:16",
  "4:1", "4:11", "4:15",
  "5:1", "5:11", "5:15",
  "6:2", "6:3", "6:5", "6:6", "6:7", "6:8", "6:9", "6:10", "6:11", "6:13", "6:14"
]);

it("stores the exact 7 by 17 source grid", () => {
  const grid = getLogoGrid();
  expect(grid).toHaveLength(7);
  expect(grid.every((row) => row.length === 17)).toBe(true);
});

it("fills every specified coordinate and leaves all unspecified coordinates empty", () => {
  const grid = getLogoGrid();
  for (let row = 0; row < 7; row += 1) {
    for (let col = 0; col < 17; col += 1) {
      expect(grid[row]?.[col], `${row}:${col}`).toBe(filledCoordinates.has(`${row}:${col}`));
    }
  }
});

it("keeps permanent gutter columns empty", () => {
  const grid = getLogoGrid();
  expect(grid.every((row) => row[4] === false && row[12] === false)).toBe(true);
});

it("keeps the accent separate at the exact coordinate", () => {
  expect(getAccentPixel()).toEqual({ row: -1, col: 16 });
});

it("renders four reset-terminated truecolor rows with the white accent", () => {
  const rendered = renderLogo();
  const rows = rendered.split("\n");
  expect(rows).toHaveLength(4);
  expect(rendered).toMatch(/\u001B\[(?:38|48);2;\d+;\d+;\d+m/u);
  expect(rendered).toContain("\u001B[48;2;255;255;255m");
  expect(rows.every((row) => row.endsWith("\u001B[0m"))).toBe(true);
  expect(rows.every((row) => row.lastIndexOf("\u001B[0m") === row.length - 4)).toBe(true);
});

it("uses the exact fallback", () => {
  expect(renderLogoFallback()).toBe("{S}");
});

it("detects truecolor without mutating global process state", () => {
  expect(supportsTrueColorFor({
    isTTY: true,
    env: { NO_COLOR: "1", COLORTERM: "truecolor" }
  })).toBe(false);
  expect(supportsTrueColorFor({
    isTTY: false,
    env: { COLORTERM: "truecolor" }
  })).toBe(false);
  expect(supportsTrueColorFor({
    isTTY: true,
    env: { COLORTERM: "truecolor" }
  })).toBe(true);
  expect(supportsTrueColorFor({
    isTTY: true,
    env: { COLORTERM: "24bit" }
  })).toBe(true);
  expect(supportsTrueColorFor({
    isTTY: false,
    env: { FORCE_COLOR: "1", NO_COLOR: "1" }
  })).toBe(true);
  expect(supportsTrueColorFor({
    isTTY: true,
    env: { FORCE_COLOR: "0", COLORTERM: "truecolor" }
  })).toBe(true);
});

it("introduces no new runtime logo dependency", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  expect(Object.keys(manifest.dependencies ?? {})).not.toContain("chalk");
  expect(Object.keys(manifest.dependencies ?? {})).not.toContain("picocolors");
  expect(Object.keys(manifest.dependencies ?? {})).not.toContain("supports-color");
});
