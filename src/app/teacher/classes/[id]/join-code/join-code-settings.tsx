"use client";

import { useActionState, useEffect, useOptimistic, useRef, useState } from "react";
import { focusRing, primaryButton, secondaryButton } from "@/components/ui";
import type { JoinCodeState } from "./state";

type Action = (state: JoinCodeState, formData: FormData) => Promise<JoinCodeState>;

// The join code's two settings rows, under the code on the class page:
// a switch to turn the code on or off, and "New code" with a small
// confirm (the old code stops working, so one extra click). Neither is
// destructive (students who joined keep their access), so no red. One
// live region says what happened.
export function JoinCodeSettings({
  code,
  codeActive,
  setActiveAction,
  newCodeAction,
}: {
  code: string;
  codeActive: boolean;
  setActiveAction: Action;
  newCodeAction: Action;
}) {
  const [optimisticActive, setOptimisticActive] = useOptimistic(codeActive);
  const [switchState, switchDispatch, switchPending] = useActionState(
    async (prev: JoinCodeState, formData: FormData) => {
      setOptimisticActive(formData.get("active") === "on");
      return setActiveAction(prev, formData);
    },
    {},
  );
  const [newState, newDispatch, newPending] = useActionState(newCodeAction, {});
  const [confirming, setConfirming] = useState(false);
  // Which result is newest, for the one live region.
  const [latest, setLatest] = useState<"switch" | "new" | null>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
    else if (returnFocus.current) newButton.current?.focus();
    returnFocus.current = false;
  }, [confirming]);

  const shown = latest === "switch" ? switchState : latest === "new" ? newState : {};
  const busy = switchPending || newPending;

  return (
    <div className="flex w-full flex-col divide-y divide-ink-200 border-t border-ink-200 text-left">
      <div className="flex items-center justify-between gap-6 py-5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p id="code-switch-label" className="text-base font-semibold text-ink-950">
            Join code on
          </p>
          <p id="code-switch-help" className="text-sm text-ink-600">
            Turn it off when everyone’s in. Students who already joined keep their access.
          </p>
        </div>
        <form action={switchDispatch} onSubmit={() => setLatest("switch")}>
          <input type="hidden" name="active" value={optimisticActive ? "off" : "on"} />
          <button
            type="submit"
            role="switch"
            aria-checked={optimisticActive}
            aria-labelledby="code-switch-label"
            aria-describedby="code-switch-help"
            disabled={busy}
            className={`relative inline-flex h-8 w-14 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              optimisticActive ? "bg-primary-600" : "bg-ink-300"
            } ${focusRing}`}
          >
            <span
              aria-hidden="true"
              className={`inline-block h-6 w-6 rounded-full bg-white shadow-sm transition-transform ${
                optimisticActive ? "translate-x-7" : "translate-x-1"
              }`}
            />
          </button>
        </form>
      </div>

      <div className="flex flex-col gap-4 py-5">
        <div className="flex items-center justify-between gap-6">
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="text-base font-semibold text-ink-950">New code</p>
            <p id="new-code-help" className="text-sm text-ink-600">
              For a code that got shared too widely. The old one stops working right away.
            </p>
          </div>
          {!confirming && (
            <button
              ref={newButton}
              type="button"
              onClick={() => setConfirming(true)}
              disabled={busy}
              aria-describedby="new-code-help"
              className={`${secondaryButton} shrink-0 disabled:cursor-not-allowed disabled:opacity-60`}
            >
              New code
            </button>
          )}
        </div>
        {confirming && (
          <form
            action={newDispatch}
            onSubmit={() => {
              setLatest("new");
              returnFocus.current = true;
              setConfirming(false);
            }}
            role="group"
            aria-labelledby="new-code-confirm"
            className="flex flex-col gap-4 rounded-xl border border-ink-200 bg-ink-50 px-4 py-4"
          >
            <p id="new-code-confirm" className="text-base text-ink-800">
              Make a new code? <span className="font-mono font-semibold tracking-wider">{code}</span> stops working
              right away. Students who already joined stay in.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <button ref={confirmButton} type="submit" disabled={busy} className={primaryButton}>
                Make new code
              </button>
              <button
                type="button"
                onClick={() => {
                  returnFocus.current = true;
                  setConfirming(false);
                }}
                className={secondaryButton}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        {newPending && <p className="text-sm text-ink-600">Making a new code…</p>}
      </div>

      <p
        aria-live="polite"
        className={`pt-5 text-base font-medium empty:hidden ${shown.error ? "text-danger-700" : "text-primary-900"}`}
      >
        {shown.error ?? shown.message ?? ""}
      </p>
    </div>
  );
}
