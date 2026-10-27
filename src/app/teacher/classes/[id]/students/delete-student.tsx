"use client";

import { startTransition, useActionState, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { dangerButton, dangerGhostButton, secondaryButton } from "@/components/ui";
import { studentDeletedMessage } from "@/lib/student-delete";
import type { DeleteStudentState } from "./state";

type Action = (state: DeleteStudentState, formData: FormData) => Promise<DeleteStudentState>;

// Fired when a student is deleted, for DeleteAnnouncer: the row (and its
// dialog) is gone after the refresh, so the message lives above the list.
const DELETED_EVENT = "unpack:student-deleted";

// The page's live region for deletes. Stays mounted while rows come and
// go, and moves focus to the heading so it isn't lost with the row.
export function DeleteAnnouncer({ headingId }: { headingId: string }) {
  const [message, setMessage] = useState("");

  useEffect(() => {
    function onDeleted(e: Event) {
      setMessage((e as CustomEvent<string>).detail);
      document.getElementById(headingId)?.focus();
    }
    window.addEventListener(DELETED_EVENT, onDeleted);
    return () => window.removeEventListener(DELETED_EVENT, onDeleted);
  }, [headingId]);

  return (
    <p
      aria-live="polite"
      className="rounded-xl border border-indigo-200 bg-indigo-50 px-5 py-3 text-base font-medium text-indigo-950 empty:hidden"
    >
      {message}
    </p>
  );
}

// The row's "Delete" button and its confirm dialog: a native modal
// <dialog> (focus stays inside, Esc closes), a red "Delete {name}" and a
// neutral Cancel, which has focus first so Enter doesn't delete.
export function DeleteStudentButton({ action, studentId, name }: { action: Action; studentId: string; name: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [state, dispatch, pending] = useActionState(async (prev: DeleteStudentState, formData: FormData) => {
    const next = await action(prev, formData);
    if (next.deleted) {
      dialog.current?.close();
      window.dispatchEvent(new CustomEvent(DELETED_EVENT, { detail: studentDeletedMessage(name) }));
    }
    return next;
  }, {});
  // useId: the table and the narrow-screen cards each render one per
  // student.
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;

  function open() {
    dialog.current?.showModal();
    cancel.current?.focus();
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const data = new FormData(e.currentTarget);
    startTransition(() => dispatch(data));
  }

  return (
    <>
      <button type="button" onClick={open} className={dangerGhostButton}>
        Delete<span className="sr-only"> {name}</span>
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onCancel={(e) => {
          if (pending) e.preventDefault();
        }}
        className="m-auto w-[min(32rem,calc(100%-2rem))] rounded-2xl border border-zinc-200 bg-white p-0 text-left shadow-xl backdrop:bg-zinc-950/40"
      >
        <form onSubmit={onSubmit} aria-busy={pending} className="flex flex-col gap-5 p-6">
          <input type="hidden" name="studentId" value={studentId} />
          <h2 id={titleId} className="text-xl font-semibold break-words text-zinc-950">
            Delete {name}?
          </h2>
          <div id={bodyId} className="flex flex-col gap-3 text-base text-zinc-700">
            <p>
              This deletes {name} and all of their work in this class: answers, tries, notes to you, and their own
              questions. It can’t be undone.
            </p>
            <p>If they open unpack again, they’ll need to join with the class code.</p>
            <p className="text-sm text-zinc-500">Our database backups keep deleted data for a short time, then it’s gone.</p>
          </div>
          <p aria-live="polite" className="text-base font-medium text-red-700 empty:hidden">
            {state.error ?? ""}
          </p>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button ref={cancel} type="button" onClick={() => dialog.current?.close()} disabled={pending} className={`${secondaryButton} disabled:cursor-not-allowed disabled:opacity-60`}>
              Cancel
            </button>
            <button type="submit" disabled={pending} className={dangerButton}>
              {pending ? "Deleting…" : `Delete ${name}`}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
