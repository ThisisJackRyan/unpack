"use client";

import { useEffect, useState } from "react";
import { secondaryButton } from "@/components/ui";

type Status = "idle" | "copied" | "failed";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [status, setStatus] = useState<Status>("idle");

  useEffect(() => {
    if (status === "idle") return;
    const timer = setTimeout(() => setStatus("idle"), 2000);
    return () => clearTimeout(timer);
  }, [status]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }

  const message =
    status === "copied" ? "Copied" : status === "failed" ? "Couldn’t copy" : "";

  return (
    <>
      <button
        type="button"
        onClick={copy}
        className={`${secondaryButton} min-w-28`}
      >
        {message || "Copy"}
        <span className="sr-only"> {label}</span>
      </button>
      <span aria-live="polite" className="sr-only">
        {message}
      </span>
    </>
  );
}
