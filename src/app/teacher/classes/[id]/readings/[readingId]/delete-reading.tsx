"use client";

import { startTransition, useActionState, useRef, type FormEvent } from "react";
import { dangerButton, dangerOutlineButton, secondaryButton } from "@/components/ui";
import { ErrorMessage } from "@/components/error-message";
import type { DeleteReadingState } from "./reading-state";

type Action = () => Promise<DeleteReadingState>;

// "Delete reading" and its confirm dialog, like the student delete: a
// native modal <dialog> (focus stays inside, Esc closes), a red "Delete"
// and a neutral Cancel, which has focus first so Enter doesn't delete.
// On success the action redirects to the class page.
export function DeleteReadingButton({ action, title }: { action: Action; title: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [state, dispatch, pending] = useActionState<DeleteReadingState>(() => action(), {});

  function open() {
    dialog.current?.showModal();
    cancel.current?.focus();
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    startTransition(() => dispatch());
  }

  return (
    <>
      <button type="button" onClick={open} className={dangerOutlineButton}>
        Delete reading
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="delete-reading-title"
        aria-describedby="delete-reading-body"
        onCancel={(e) => {
          if (pending) e.preventDefault();
        }}
        className="m-auto w-[min(32rem,calc(100%-2rem))] rounded-3xl border border-ink-200 bg-white p-0 text-left shadow-xl backdrop:bg-ink-950/40"
      >
        <form onSubmit={onSubmit} aria-busy={pending} className="flex flex-col gap-5 p-6">
          <h2 id="delete-reading-title" className="text-xl font-semibold break-words text-ink-950">
            Delete “{title}”?
          </h2>
          <div id="delete-reading-body" className="flex flex-col gap-3 text-base text-ink-700">
            <p>
              This deletes the reading, its questions, and every student’s answers and tries for it, including their
              notes to you. It can’t be undone.
            </p>
            <p>Students stay in the class, and their work on other readings is kept.</p>
            <p className="text-base text-ink-700">Our database backups keep deleted data for a short time, then it’s gone.</p>
          </div>
          <ErrorMessage>
            {state.error ?? ""}
          </ErrorMessage>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              ref={cancel}
              type="button"
              onClick={() => dialog.current?.close()}
              disabled={pending}
              className={`${secondaryButton} disabled:cursor-not-allowed disabled:opacity-60`}
            >
              Cancel
            </button>
            <button type="submit" disabled={pending} className={dangerButton}>
              {pending ? "Deleting…" : "Delete"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
