"use client";

import { useEffect, useRef, useState } from "react";

import { reduceCopyStatus, type CopyStatus } from "./copy-button-state.js";

export interface CopyButtonProps {
  readonly label: string;
  readonly source: string;
}

export function CopyButton({ label, source }: CopyButtonProps) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => {
    if (resetTimer.current !== undefined) clearTimeout(resetTimer.current);
  }, []);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(source);
      setStatus((current) => reduceCopyStatus(current, "copy-success"));
    } catch {
      setStatus((current) => reduceCopyStatus(current, "copy-error"));
    }

    if (resetTimer.current !== undefined) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      setStatus((current) => reduceCopyStatus(current, "reset"));
    }, 1800);
  }

  const visibleLabel = status === "copied" ? "Copied" : status === "error" ? "Try again" : "Copy";
  const announcement = status === "copied" ? "Code copied to clipboard." : status === "error" ? "Code could not be copied." : "";

  return (
    <button
      type="button"
      className="scribe-copy-button"
      aria-label={label}
      data-state={status}
      onClick={copy}
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16">
        <path d="M7.25 6.25V4.5A1.75 1.75 0 0 1 9 2.75h6.5a1.75 1.75 0 0 1 1.75 1.75V11A1.75 1.75 0 0 1 15.5 12.75h-1.75" />
        <rect x="2.75" y="7.25" width="10" height="10" rx="1.75" />
      </svg>
      <span aria-hidden="true">{visibleLabel}</span>
      <span className="scribe-visually-hidden" aria-live="polite">{announcement}</span>
    </button>
  );
}
