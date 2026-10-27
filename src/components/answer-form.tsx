"use client";

import { startTransition, useActionState, useState, type FormEvent } from "react";
import { NoCopyTextarea } from "@/components/no-copy";
import { pill, primaryButtonLarge } from "@/components/ui";
import { passedCountLabel, type AttemptView } from "@/lib/reading-progress";
import type { StudentQuestion } from "@/lib/student-questions-core";
import {
  answerBox,
  CharacterCount,
  fieldError,
  Nudge,
  QuestionNumber,
  ResultBadge,
  RetryIcon,
  Spinner,
} from "./answer-parts";
import { ANSWER_FIELD_PREFIX, ANSWER_MAX_LENGTH } from "@/lib/validate-answers";
import type { AnswerFormState } from "./answer-form-state";
import { LimitNotice } from "./limit-notice";

type Props = {
  action: (state: AnswerFormState, formData: FormData) => Promise<AnswerFormState>;
  questions: StudentQuestion[];
  tryNumber: number;
  maxTries: number;
  // The teacher denied the note but gave one more try: exactly 1 left.
  extraTry: boolean;
  // The last failed try: its answers prefill the boxes, with each one's
  // result and nudge. Students answer every question each try; passed
  // answers stay editable.
  previous: AttemptView | null;
};

const initialState: AnswerFormState = {};

function prefill(questions: StudentQuestion[], previous: AttemptView | null): Record<string, string> {
  return Object.fromEntries(questions.map((q) => [q.id, previous?.answers[q.id]?.text ?? ""]));
}

// Every question with an answer box, and one button that checks them all.
// The form submits through a transition (not the form action prop), so
// React doesn't reset the boxes after a check.
export function AnswerForm({ action, questions, tryNumber, maxTries, extraTry, previous }: Props) {
  const [state, dispatch, pending] = useActionState(action, initialState);
  const [values, setValues] = useState(() => prefill(questions, previous));
  // A new try (the page re-renders after a check): start from its answers.
  const [shownTry, setShownTry] = useState(tryNumber);
  if (shownTry !== tryNumber) {
    setShownTry(tryNumber);
    setValues(prefill(questions, previous));
  }
  const errors = state.errors ?? {};

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const data = new FormData(e.currentTarget);
    startTransition(() => dispatch(data));
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-busy={pending} className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`${pill} bg-primary-50 px-3 py-1 text-base font-semibold text-primary-800`}>
          {extraTry ? "1 try left" : `Try ${tryNumber} of ${maxTries}`}
        </span>
        <span className="text-base text-ink-600">Copy and paste are off. Use your own words.</span>
      </div>

      {extraTry ? (
        <div className="flex gap-3 rounded-2xl border border-primary-200 bg-primary-50 px-5 py-4 text-primary-950">
          <RetryIcon className="mt-1 h-5 w-5 shrink-0 text-primary-700" />
          <div className="flex flex-col gap-1">
            <p className="text-lg font-semibold">Your teacher gave you one more try.</p>
            <p className="text-lg">
              {previous
                ? "Read the tips under your answers. Take your time, then check again."
                : "Take your time with each answer, then check again."}
            </p>
          </div>
        </div>
      ) : previous && (
        <div className="flex gap-3 rounded-2xl border border-warning-200 bg-warning-50 px-5 py-4 text-warning-950">
          <RetryIcon className="mt-1 h-5 w-5 shrink-0 text-warning-700" />
          <div className="flex flex-col gap-1">
            <p className="text-lg font-semibold">Not yet. {passedCountLabel(previous)}</p>
            <p className="text-lg">Read the tips under your answers. Then fix them and check again.</p>
          </div>
        </div>
      )}

      <ol className="flex flex-col gap-4">
        {questions.map((q) => {
          const id = `answer-${q.id}`;
          const result = previous?.answers[q.id];
          const nudge = result && !result.pass && result.nudge ? result.nudge : "";
          const error = errors[q.id];
          const value = values[q.id] ?? "";
          const describedBy = [nudge && `${id}-nudge`, `${id}-count`, error && `${id}-error`].filter(Boolean).join(" ");
          return (
            <li key={q.id} className="flex flex-col gap-4 rounded-2xl border border-ink-200 bg-white p-5 sm:p-6">
              <div className="flex gap-4">
                <QuestionNumber position={q.position} />
                <label htmlFor={id} className="pt-1.5 text-lg leading-relaxed font-medium break-words text-ink-900">
                  <span className="sr-only">Question {q.position}: </span>
                  {q.prompt}
                </label>
              </div>
              {result && (
                <div className="flex flex-col items-start gap-3">
                  <ResultBadge pass={result.pass} />
                  {nudge && <Nudge id={`${id}-nudge`} text={nudge} />}
                </div>
              )}
              <NoCopyTextarea
                id={id}
                name={`${ANSWER_FIELD_PREFIX}${q.id}`}
                rows={4}
                maxLength={ANSWER_MAX_LENGTH}
                value={value}
                onChange={(e) => {
                  const next = e.target.value;
                  setValues((v) => ({ ...v, [q.id]: next }));
                }}
                readOnly={pending}
                autoComplete="off"
                aria-invalid={error ? true : undefined}
                aria-describedby={describedBy}
                className={answerBox}
              />
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                <p id={`${id}-error`} aria-live="polite" className={`${fieldError} empty:hidden`}>
                  {error}
                </p>
                <CharacterCount id={`${id}-count`} length={value.length} max={ANSWER_MAX_LENGTH} />
              </div>
            </li>
          );
        })}
      </ol>

      <p aria-live="polite" className="text-lg font-medium text-ink-800 empty:hidden">
        {state.message}
      </p>
      {state.limit && <LimitNotice large>{state.limit}</LimitNotice>}

      {/* Always shown, before the click too, so a student knows not to
          give up or click again while a check runs (up to the 60s
          EFFORT_CHECK_DEADLINE_MS). */}
      <div className="flex flex-col gap-2">
        <button
          type="submit"
          disabled={pending}
          aria-describedby="check-time"
          className={`${primaryButtonLarge} w-full sm:w-auto sm:self-start`}
        >
          {pending && <Spinner />}
          {pending ? "Checking your answers…" : "Check my answers"}
        </button>
        <p id="check-time" className="text-base text-ink-600">
          This can take up to a minute.
        </p>
      </div>
    </form>
  );
}
