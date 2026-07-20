import { isAbsolute, relative, sep } from "node:path";

export type OutputKind = "success" | "warning" | "error" | "accent";

const ansi = {
  success: "32",
  warning: "33",
  error: "31",
  accent: "36"
} as const;

export function supportsColor(
  isTTY: boolean,
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return isTTY && !("NO_COLOR" in env) && env.TERM !== "dumb";
}

export function colorize(value: string, kind: OutputKind, enabled: boolean): string {
  return enabled ? `\u001B[${ansi[kind]}m${value}\u001B[0m` : value;
}

export function displayPath(root: string, path: string): string {
  const value = relative(root, path);
  if (value === "") return ".";
  return value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value) ? path : value;
}

export function commandArgument(value: string): string {
  return /[\s"']/u.test(value) ? JSON.stringify(value) : value;
}

export function suggestClosest(input: string, candidates: readonly string[]): string | undefined {
  const ranked = candidates
    .map((candidate) => ({ candidate, distance: editDistance(input, candidate) }))
    .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate));
  const best = ranked[0];
  if (!best || best.distance > 2 || ranked[1]?.distance === best.distance) return undefined;
  return best.candidate;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1] as number
        + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] as number) + 1,
        (previous[rightIndex] as number) + 1,
        substitution
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] as number;
}
