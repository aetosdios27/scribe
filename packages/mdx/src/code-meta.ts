export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export interface ScribeCodeMetadata {
  readonly filename?: string;
  readonly lineNumbers: boolean;
  readonly highlight: readonly LineRange[];
  readonly focus: readonly LineRange[];
}

export interface MetadataIssue {
  readonly code: "SCB1001" | "SCB1002";
  readonly message: string;
  readonly start: number;
  readonly end: number;
}

export interface ParsedCodeMetadata {
  readonly value: ScribeCodeMetadata;
  readonly issues: readonly MetadataIssue[];
}

const namedFields = new Set(["filename", "highlight", "focus"]);

export function parseCodeMetadata(
  raw: string | undefined,
  lineCount: number
): ParsedCodeMetadata {
  const source = raw ?? "";
  const issues: MetadataIssue[] = [];
  const seen = new Set<string>();
  const values = new Map<string, string>();
  let lineNumbers = false;
  let cursor = 0;

  while (cursor < source.length) {
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (cursor >= source.length) break;

    const fieldStart = cursor;
    while (/[A-Za-z0-9_-]/u.test(source[cursor] ?? "")) cursor += 1;
    const field = source.slice(fieldStart, cursor);

    if (!field) {
      const end = nextWhitespace(source, cursor);
      issues.push(issue("SCB1001", "Expected a named Scribe code field.", cursor, end));
      cursor = end;
      continue;
    }

    if (seen.has(field)) {
      issues.push(issue("SCB1001", `Duplicate Scribe code field \`${field}\`.`, fieldStart, cursor));
    }
    seen.add(field);

    if (field === "lineNumbers") {
      lineNumbers = true;
      if (source[cursor] === "=") {
        const end = nextWhitespace(source, cursor);
        issues.push(issue("SCB1001", "`lineNumbers` is a flag and does not accept a value.", fieldStart, end));
        cursor = end;
      }
      continue;
    }

    if (!namedFields.has(field)) {
      const end = consumeOptionalValue(source, cursor);
      issues.push(issue("SCB1001", `Unknown Scribe code field \`${field}\`.`, fieldStart, end));
      cursor = end;
      continue;
    }

    if (source[cursor] !== "=" || source[cursor + 1] !== '"') {
      const end = nextWhitespace(source, cursor);
      issues.push(
        issue("SCB1001", `\`${field}\` requires a double-quoted value.`, fieldStart, end)
      );
      cursor = end;
      continue;
    }

    cursor += 2;
    const valueStart = cursor;
    while (cursor < source.length && source[cursor] !== '"') cursor += 1;
    if (cursor >= source.length) {
      issues.push(issue("SCB1001", `Unclosed value for \`${field}\`.`, fieldStart, source.length));
      break;
    }

    values.set(field, source.slice(valueStart, cursor));
    cursor += 1;
  }

  const highlight = parseRanges("highlight", values.get("highlight"), lineCount, source, issues);
  const focus = parseRanges("focus", values.get("focus"), lineCount, source, issues);
  const filename = values.get("filename");
  const value: ScribeCodeMetadata = filename === undefined
    ? { lineNumbers, highlight, focus }
    : { filename, lineNumbers, highlight, focus };

  return { value, issues };
}

function parseRanges(
  field: "highlight" | "focus",
  raw: string | undefined,
  lineCount: number,
  source: string,
  issues: MetadataIssue[]
): LineRange[] {
  if (raw === undefined || raw.length === 0) return [];

  const ranges: LineRange[] = [];
  for (const part of raw.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(part);
    const start = match ? Number(match[1]) : 0;
    const end = match ? Number(match[2] ?? match[1]) : 0;
    if (!match || start < 1 || end < start || end > lineCount) {
      const valueStart = Math.max(0, source.indexOf(raw));
      issues.push(
        issue(
          "SCB1002",
          `Invalid \`${field}\` range \`${part}\`; use positive lines within 1-${lineCount}.`,
          valueStart,
          valueStart + raw.length
        )
      );
      return [];
    }
    ranges.push({ start, end });
  }
  return ranges;
}

function issue(
  code: MetadataIssue["code"],
  message: string,
  start: number,
  end: number
): MetadataIssue {
  return { code, message, start, end };
}

function nextWhitespace(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length && !/\s/u.test(source[cursor] ?? "")) cursor += 1;
  return cursor;
}

function consumeOptionalValue(source: string, start: number): number {
  if (source[start] !== "=") return start;
  if (source[start + 1] !== '"') return nextWhitespace(source, start);
  const closingQuote = source.indexOf('"', start + 2);
  return closingQuote === -1 ? source.length : closingQuote + 1;
}
