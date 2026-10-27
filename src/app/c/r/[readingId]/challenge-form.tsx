"use client";

import { startTransition, useActionState, useState, type FormEvent } from "react";
import { PaperPlane } from "@/components/illustrations";
import { MaxLengthNote } from "@/components/max-length-note";
import { NoCopyTextarea } from "@/components/no-copy";
import { primaryButtonLarge } from "@/components/ui";
import { answerBox, CharacterCount, fieldError, Spinner } from "@/components/answer-parts";
import { CHALLENGE_NOTE_MAX_LENGTH, type ChallengeFormState } from "./form-state";

const initialState: ChallengeFormState = {};

// After the last failed try, or once every check is used: one short note
// asking the teacher to look. `intro` explains why it's here, when the
// banner above doesn't already. Once sent, the page re-renders with the
// sent state.
export function ChallengeForm({
  action,
  intro,
}: {
  action: (state: ChallengeFormState, formData: FormData) => Promise<ChallengeFormState>;
  intro?: string;
}) {
  const [state, dispatch, pending] = useActionState(action, initialState);
  const [note, setNote] = useState("");

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const data = new FormData(e.currentTarget);
    startTransition(() => dispatch(data));
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-labelledby="challenge-heading"
      className="flex flex-col gap-4 rounded-3xl border-2 border-primary-200 bg-primary-50 p-5 sm:p-6"
    >
      <div className="flex items-center justify-between gap-4">
        <h3 id="challenge-heading" className="text-2xl font-bold text-ink-950">
          Ask your teacher to take a look
        </h3>
        <PaperPlane className="h-16 w-20 shrink-0" />
      </div>
      {intro && <p className="text-lg leading-relaxed text-ink-800">{intro}</p>}
      <label htmlFor="challenge-note" className="text-xl font-bold text-ink-950">
        Your note to your teacher
      </label>
      <NoCopyTextarea
        id="challenge-note"
        name="note"
        rows={3}
        maxLength={CHALLENGE_NOTE_MAX_LENGTH}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        readOnly={pending}
        autoComplete="off"
        aria-invalid={state.error ? true : undefined}
        aria-describedby={`challenge-note-count${state.error ? " challenge-note-error" : ""}`}
        className={answerBox}
      />
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <p id="challenge-note-error" aria-live="polite" className={`${fieldError} empty:hidden`}>
          {state.error}
        </p>
        <CharacterCount id="challenge-note-count" length={note.length} max={CHALLENGE_NOTE_MAX_LENGTH} />
        <MaxLengthNote id="challenge-note-max" length={note.length} max={CHALLENGE_NOTE_MAX_LENGTH} />
      </div>
      <button type="submit" disabled={pending} className={`${primaryButtonLarge} w-full sm:w-auto sm:self-start`}>
        {pending && <Spinner />}
        {pending ? "Sending…" : "Send to my teacher"}
      </button>
    </form>
  );
}
