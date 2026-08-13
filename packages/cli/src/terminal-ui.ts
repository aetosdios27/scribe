import {
  cancel as clackCancel,
  confirm as clackConfirm,
  isCancel,
  log,
  text
} from "@clack/prompts";

import { supportsColor } from "./cli-output.js";

const ansi = {
  blue: "94",
  dim: "2",
  error: "31",
  success: "32",
  warning: "33"
} as const;

export interface TerminalPresentation {
  readonly color: boolean;
  readonly columns: number;
}

export type UiTone = "default" | "dim" | "success" | "warning" | "error" | "brand";

export interface UiRow {
  readonly label: string;
  readonly value: string;
  readonly tone?: UiTone;
}

export interface UiPanel {
  readonly title: string;
  readonly description?: string;
  readonly rows?: readonly UiRow[];
  readonly footer?: string;
}
export interface UiSection {
  readonly title: string;
  readonly lines: readonly string[];
  readonly tone?: UiTone;
}

export interface UiReport {
  readonly title: string;
  readonly description?: string;
  readonly sections: readonly UiSection[];
  readonly footer?: string;
}


export interface TextPromptOptions {
  readonly message: string;
  readonly initialValue?: string;
  readonly placeholder?: string;
  readonly validate?: (value: string) => string | undefined;
}

export function terminalPresentation(
  isTTY = process.stdout.isTTY === true,
  env: Readonly<Record<string, string | undefined>> = process.env,
  columns = process.stdout.columns ?? 80
): TerminalPresentation {
  return {
    color: supportsColor(isTTY, env),
    columns: Math.max(32, columns)
  };
}

export function renderPanel(
  panel: UiPanel,
  presentation: TerminalPresentation = terminalPresentation()
): string {
  const labelWidth = Math.max(0, ...((panel.rows ?? []).map(({ label }) => label.length)));
  const top = `${paint("╭─", "brand", presentation.color)} ${paint(panel.title, "brand", presentation.color)}`;
  const lines = [top];

  if (panel.description !== undefined) {
    lines.push(`${paint("│", "brand", presentation.color)} ${paint(panel.description, "dim", presentation.color)}`);
  }
  if (panel.rows !== undefined && panel.rows.length > 0) {
    lines.push(paint("│", "brand", presentation.color));
    for (const row of panel.rows) {
      const label = row.label.padEnd(labelWidth);
      const inlineLength = 2 + labelWidth + row.value.length;
      if (presentation.columns < 48 || inlineLength > presentation.columns - 2) {
        lines.push(`${paint("│", "brand", presentation.color)} ${paint(row.label, "dim", presentation.color)}`);
        lines.push(`${paint("│", "brand", presentation.color)}   ${paint(row.value, row.tone ?? "default", presentation.color)}`);
      } else {
        lines.push(
          `${paint("│", "brand", presentation.color)} ${paint(label, "dim", presentation.color)}  ${paint(row.value, row.tone ?? "default", presentation.color)}`
        );
      }
    }
  }
  if (panel.footer !== undefined) {
    lines.push(paint("│", "brand", presentation.color));
    lines.push(`${paint("│", "brand", presentation.color)} ${paint(panel.footer, "dim", presentation.color)}`);
  }
  lines.push(paint("╰─", "brand", presentation.color));
  return `${lines.join("\n")}\n`;
}
export function renderReport(
  report: UiReport,
  presentation: TerminalPresentation = terminalPresentation()
): string {
  const lines = [
    `${paint("╭─", "brand", presentation.color)} ${paint(report.title, "brand", presentation.color)}`
  ];
  if (report.description !== undefined) {
    lines.push(`${paint("│", "brand", presentation.color)} ${paint(report.description, "dim", presentation.color)}`);
  }
  for (const section of report.sections) {
    lines.push(`${paint("├─", "brand", presentation.color)} ${paint(section.title, section.tone ?? "default", presentation.color)}`);
    for (const line of section.lines) {
      lines.push(`${paint("│", "brand", presentation.color)} ${line}`);
    }
  }
  if (report.footer !== undefined) {
    lines.push(`${paint("╰─", "brand", presentation.color)} ${paint(report.footer, "dim", presentation.color)}`);
  } else {
    lines.push(paint("╰─", "brand", presentation.color));
  }
  return `${lines.join("\n")}\n`;
}


export function renderReceipt(
  state: "success" | "warning" | "error" | "cancelled",
  title: string,
  details: readonly string[] = [],
  presentation: TerminalPresentation = terminalPresentation()
): string {
  const tone: UiTone = state === "cancelled" ? "dim" : state;
  const symbol = state === "success" ? "✓" : state === "warning" ? "!" : state === "error" ? "×" : "–";
  return [
    `${paint(symbol, tone, presentation.color)} ${paint(title, tone, presentation.color)}`,
    ...details.map((detail) => `  ${paint(detail, "dim", presentation.color)}`),
    ""
  ].join("\n");
}

export function renderTask(
  state: "pending" | "active" | "success" | "error",
  label: string,
  detail?: string,
  presentation: TerminalPresentation = terminalPresentation()
): string {
  const symbol = state === "pending" ? "○" : state === "active" ? "◆" : state === "success" ? "✓" : "×";
  const tone: UiTone = state === "pending" ? "dim" : state === "active" ? "brand" : state;
  return `${paint(symbol, tone, presentation.color)} ${label}${detail === undefined ? "" : `  ${paint(detail, "dim", presentation.color)}`}\n`;
}

export async function promptText(options: TextPromptOptions): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const result = await text({
    message: options.message,
    ...(options.initialValue === undefined ? {} : { initialValue: options.initialValue }),
    ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
    ...(options.validate === undefined
      ? {}
      : { validate: (value: string | undefined) => options.validate?.(value ?? "") }),
    withGuide: true
  });
  return isCancel(result) ? null : result;
}

export async function promptConfirm(message: string, initialValue = true): Promise<boolean | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const result = await clackConfirm({ message, initialValue, withGuide: true });
  return isCancel(result) ? null : result;
}

export function reportPromptCancellation(message: string): void {
  clackCancel(message);
}

export function reportTaskStep(message: string): void {
  log.step(message);
}

export function reportTaskSuccess(message: string): void {
  log.success(message);
}

export function reportTaskError(message: string): void {
  log.error(message);
}

function paint(value: string, tone: UiTone, enabled: boolean): string {
  if (!enabled || tone === "default") return value;
  const code = tone === "brand" ? ansi.blue : ansi[tone];
  return `\u001B[${code}m${value}\u001B[0m`;
}
