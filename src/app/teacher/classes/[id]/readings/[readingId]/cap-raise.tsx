"use client";

import { useActionState } from "react";
import { primaryButton } from "@/components/ui";
import { ErrorBox } from "@/components/error-message";
import type { RaiseCapState } from "./reading-state";

type Action = () => Promise<RaiseCapState>;

// "Raise the limit to 300", under the reading's cap note. Neutral and
// indigo: it changes no student data. Disabled while pending; one live
// region says what happened (the page then shows the new limit).
export function RaiseCapButton({ action, raiseTo }: { action: Action; raiseTo: number }) {
  const [state, dispatch, pending] = useActionState<RaiseCapState>(() => action(), {});
  return (
    <form action={dispatch} className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? "Raising…" : `Raise the limit to ${raiseTo}`}
      </button>
      <div aria-live="polite" className="text-lg font-medium text-primary-900 empty:hidden">
        {pending ? "" : state.error ? <ErrorBox>{state.error}</ErrorBox> : (state.message ?? "")}
      </div>
    </form>
  );
}
