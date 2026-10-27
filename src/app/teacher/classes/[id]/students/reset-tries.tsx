"use client";

import { startTransition, useActionState, type FormEvent } from "react";
import { secondaryButton, secondarySmallButton } from "@/components/ui";
import { resetTriesMessage } from "@/lib/student-question-reset";
import { announceProgress } from "./announcer";
import type { ResetTriesState } from "./state";

type Action = (state: ResetTriesState, formData: FormData) => Promise<ResetTriesState>;

// "Let them try again", shown only where a student Needs a reset. Neutral
// (it undoes nothing and deletes no work), no confirm. Success goes to the
// page's ProgressAnnouncer, since this button is gone once the page
// refreshes; an error stays here, in its own live region.
export function ResetTriesButton({
  action,
  studentId,
  readingId,
  name,
  readingTitle,
  size = "sm",
}: {
  action: Action;
  studentId: string;
  readingId: string;
  name: string;
  readingTitle: string;
  // "sm" in the progress table and cards, "base" on the student's page.
  size?: "sm" | "base";
}) {
  const [state, dispatch, pending] = useActionState(async (prev: ResetTriesState, formData: FormData) => {
    const next = await action(prev, formData);
    if (next.reset) announceProgress(resetTriesMessage(name));
    return next;
  }, {});

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const data = new FormData(e.currentTarget);
    startTransition(() => dispatch(data));
  }

  return (
    <form onSubmit={onSubmit} aria-busy={pending} className="flex flex-col items-start gap-1.5">
      <input type="hidden" name="studentId" value={studentId} />
      <input type="hidden" name="readingId" value={readingId} />
      <button
        type="submit"
        disabled={pending}
        className={size === "sm" ? secondarySmallButton : `${secondaryButton} disabled:cursor-not-allowed disabled:opacity-60`}
      >
        {pending ? "Resetting…" : "Let them try again"}
        <span className="sr-only">
          {" "}
          ({name}, {readingTitle})
        </span>
      </button>
      <p aria-live="polite" className="text-sm font-medium text-red-700 empty:hidden">
        {state.error ?? ""}
      </p>
    </form>
  );
}
