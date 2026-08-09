"use client";

import { useState, type MouseEvent } from "react";

export interface WrapToggleButtonProps {
  readonly label?: string;
  readonly defaultWrapped?: boolean;
}

export function WrapToggleButton({ label = "Toggle line wrap", defaultWrapped = false }: WrapToggleButtonProps) {
  const [wrapped, setWrapped] = useState(defaultWrapped);

  function toggle(event: MouseEvent<HTMLButtonElement>): void {
    const frame = event.currentTarget.closest(".scribe-code-frame");
    const pre = frame?.querySelector(".scribe-code-frame__pre");
    if (!pre) return;

    const next = !pre.hasAttribute("data-scribe-wrap");
    if (next) {
      pre.setAttribute("data-scribe-wrap", "");
    } else {
      pre.removeAttribute("data-scribe-wrap");
    }
    setWrapped(next);
  }

  return (
    <button
      type="button"
      className="scribe-wrap-toggle-button"
      aria-label={label}
      aria-pressed={wrapped}
      data-state={wrapped ? "wrapped" : "unwrapped"}
      onClick={toggle}
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16">
        <path d="M2.75 5.75h14.5M2.75 10h10.5a2 2 0 0 1 0 4h-2.25M11 12.25 8.75 14l2.25 1.75M2.75 14.25h4" />
      </svg>
    </button>
  );
}
