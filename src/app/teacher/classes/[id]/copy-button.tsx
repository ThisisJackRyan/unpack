"use client";

import { useEffect, useState } from "react";
import { CheckIcon } from "@/components/answer-parts";
import { secondaryButton } from "@/components/ui";
import { COPY_STATUS_TEXT, type CopyStatus } from "./copy-status";

// Copies the value and says so: the button reads "Copied!" with a check
// for 2 seconds, and a polite status region announces the same. If the
// clipboard isn't available (an old browser, or no permission), the code
// is selected and a visible note asks to copy it by hand.
export function CopyButton({
  value,
  label,
  selectId,
}: {
  value: string;
  label: string;
  selectId?: string;
}) {
  const [status, setStatus] = useState<CopyStatus>("idle");

  useEffect(() => {
    if (status !== "copied") return;
    const timer = setTimeout(() => setStatus("idle"), 2000);
    return () => clearTimeout(timer);
  }, [status]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      setStatus("failed");
      selectText(selectId);
    }
  }

  const copied = status === "copied";

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={copy}
        className={`${copied ? copiedButton : secondaryButton} min-w-36`}
      >
        {copied ? <CheckIcon className="h-5 w-5" /> : <CopyIcon />}
        {copied ? COPY_STATUS_TEXT.copiedButton : COPY_STATUS_TEXT.idleButton}
        <span className="sr-only"> {label}</span>
      </button>
      <p role="status" className="max-w-sm text-base font-medium text-ink-900">
        {copied && <span className="sr-only">{COPY_STATUS_TEXT.copiedAnnouncement}</span>}
        {status === "failed" && COPY_STATUS_TEXT.failed}
      </p>
    </div>
  );
}

// Tailwind orders same-property utilities by name, so swap the colors in
// the string rather than adding classes on top.
const copiedButton = secondaryButton
  .replace("border-ink-400", "border-primary-600")
  .replace("text-ink-900", "text-primary-800")
  .replace(" bg-white", " bg-primary-50")
  .replace("hover:bg-ink-50", "hover:bg-primary-100");

function selectText(id: string | undefined) {
  const el = id ? document.getElementById(id) : null;
  const selection = window.getSelection();
  if (!el || !selection) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
}

// Two overlapping pages.
function CopyIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-5 w-5">
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path strokeLinecap="round" d="M13 4.5V4a1.5 1.5 0 0 0-1.5-1.5h-7A1.5 1.5 0 0 0 3 4v7a1.5 1.5 0 0 0 1.5 1.5H5" />
    </svg>
  );
}
