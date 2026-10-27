"use client";

import { useEffect } from "react";
import { card, primaryButton } from "@/components/ui";

export default function StudentError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div role="alert" className={`${card} flex flex-col items-center gap-3 rounded-2xl px-6 py-14 text-center`}>
      <h1 className="text-2xl font-semibold text-zinc-950">Something went wrong</h1>
      <p className="text-lg text-zinc-600">We couldn’t load this page. Please try again.</p>
      <button type="button" onClick={() => unstable_retry()} className={`${primaryButton} mt-3 min-h-14 px-7 text-lg`}>
        Try again
      </button>
    </div>
  );
}
