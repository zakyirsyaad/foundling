"use client";

import { useEffect, useRef, useState } from "react";

const COPIED_MS = 1500;

/** `icon` draws the design's square icon button; the default stays a small text button. */
export function CopyButton({ text, label, icon = false }: { text: string; label: string; icon?: boolean }) {
  const [copied, setCopied] = useState(false);
  // One timer at a time: a second click restarts the "copied" window instead of being cut short by the first.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      aria-label={label}
      className={icon ? "fm-icon-btn" : "fm-copy"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), COPIED_MS);
        } catch {
          setCopied(false);
        }
      }}
    >
      {icon ? <CopyIcon copied={copied} /> : copied ? "Copied" : "Copy"}
    </button>
  );
}

function CopyIcon({ copied }: { copied: boolean }) {
  return (
    <svg className="fm-icon" viewBox="0 0 24 24" aria-hidden="true">
      {copied ? (
        <path d="M20 6 9 17l-5-5" />
      ) : (
        <>
          <rect width="14" height="14" x="8" y="8" rx="2" />
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </>
      )}
    </svg>
  );
}
