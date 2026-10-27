"use client";

import { useEffect } from "react";
import { card, primaryButton } from "@/components/ui";

export default function TeacherError({
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
    <div
      role="alert"
      className={`${card} flex flex-col items-center gap-3 px-6 py-14 text-center`}
    >
      <h1 className="text-2xl font-semibold text-ink-950">
        Something went wrong
      </h1>
      <p className="text-base text-ink-700">
        We couldn’t load this page. Please try again.
      </p>
      <button
        type="button"
        onClick={() => unstable_retry()}
        className={`${primaryButton} mt-3`}
      >
        Try again
      </button>
    </div>
  );
}
