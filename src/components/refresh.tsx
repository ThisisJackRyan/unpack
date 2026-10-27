"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { primaryButtonLarge } from "@/components/ui";
import { WritingQuestions } from "@/components/writing-questions";

// While another request writes this student's questions, the page asks
// again every retryAfterMs (router.refresh re-runs the server lookup and
// keeps this component's state). After maxTries it stops and offers a
// button instead, so a stuck tab doesn't poll forever.
export function PendingRefresh({
  retryAfterMs,
  maxTries,
}: {
  retryAfterMs: number;
  maxTries: number;
}) {
  const router = useRouter();
  const [tries, setTries] = useState(0);
  const waiting = tries < maxTries;

  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => {
      setTries((n) => n + 1);
      router.refresh();
    }, retryAfterMs);
    return () => clearTimeout(timer);
  }, [router, retryAfterMs, tries, waiting]);

  return waiting ? (
    <WritingQuestions />
  ) : (
    <div role="status" className="flex flex-col items-start gap-5">
      <p className="text-lg font-medium text-ink-700">This is taking longer than usual.</p>
      <TryAgainButton onClick={() => setTries(0)} />
    </div>
  );
}

// For the error view: asks the server again (a failed write saved nothing,
// so the next open tries once more).
export function RetryButton() {
  const router = useRouter();
  return <TryAgainButton onClick={() => router.refresh()} />;
}

function TryAgainButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`${primaryButtonLarge} self-start`}>
      Try again
    </button>
  );
}
