"use client";

import { startTransition, useActionState, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { pill, primaryButton, secondaryButton } from "@/components/ui";
import {
  decisionMessage,
  GIVE_EXTRA_TRY_LABEL,
  GIVE_EXTRA_TRY_PENDING,
  grantMessage,
  NO_NOTE_LABEL,
  noNoteHelp,
  triesUsedLabel,
  parseDecisionChoice,
  type DecisionChoice,
  type NoNoteItem,
  type QueueEntry,
  type QueueItem,
} from "@/lib/challenge-queue-core";
import { ErrorMessage } from "@/components/error-message";
import { MetaLine } from "@/components/meta-line";
import { studentOnReading } from "@/lib/meta-line";
import type { DecideState, GrantState } from "./state";

type Action = (state: DecideState, formData: FormData) => Promise<DecideState>;
type GrantAction = (state: GrantState, formData: FormData) => Promise<GrantState>;

const secondaryButtonDisabled = `${secondaryButton} disabled:cursor-not-allowed disabled:opacity-60`;

// The queue, with one live region that stays mounted while cards come and
// go: after a decision (or one more try on a no-note row) the page
// refreshes, the card is gone, and the region still says what happened.
// Focus moves to the heading so it isn't lost with the card.
export function ChallengeQueue({
  action,
  grantAction,
  classId,
  entries,
}: {
  action: Action;
  grantAction: GrantAction;
  classId: string;
  entries: QueueEntry[];
}) {
  const [announcement, setAnnouncement] = useState("");
  const [focusHeading, setFocusHeading] = useState(0);

  useEffect(() => {
    if (focusHeading > 0) document.getElementById("queue-heading")?.focus();
  }, [focusHeading]);

  // `stays`: the card or row is still there (busy), so focus stays too.
  function onDecided(message: string, stays = false) {
    setAnnouncement(message);
    if (!stays) setFocusHeading((n) => n + 1);
  }

  return (
    <>
      <p
        aria-live="polite"
        className="rounded-2xl border border-primary-200 bg-primary-50 px-5 py-3 text-lg font-medium text-primary-950 empty:hidden"
      >
        {announcement}
      </p>
      {entries.length > 0 && (
        <ol className="flex flex-col gap-6">
          {entries.map((entry) =>
            entry.kind === "challenge" ? (
              <ChallengeCard key={entry.key} action={action} item={entry.item} onDecided={onDecided} />
            ) : (
              <NoNoteRow key={entry.key} action={grantAction} classId={classId} item={entry.item} onDecided={onDecided} />
            ),
          )}
        </ol>
      )}
    </>
  );
}

// Out of tries, no note yet: one row, a short status line, the way to
// their answers, and "Give one more try" (the same grant as "Deny, give
// one more try", without a note; secondary, not a warning: it undoes
// nothing). Once given, the page refreshes and the row is gone.
function NoNoteRow({
  action,
  classId,
  item,
  onDecided,
}: {
  action: GrantAction;
  classId: string;
  item: NoNoteItem;
  onDecided: (message: string, stays?: boolean) => void;
}) {
  const key = `${item.studentId}:${item.readingId}`;
  const [state, dispatch, pending] = useActionState(async (prev: GrantState, formData: FormData) => {
    const next = await action(prev, formData);
    if (next.result) onDecided(grantMessage(next.result, item.studentName), next.result.status === "busy");
    return next;
  }, {});

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const data = new FormData(e.currentTarget);
    startTransition(() => dispatch(data));
  }

  const headingId = `no-note-${item.studentId}-${item.readingId}`;
  const answersHref = `/teacher/classes/${classId}/students/${item.studentId}?reading=${item.readingId}#reading-${item.readingId}`;
  return (
    <li aria-labelledby={headingId} className="flex flex-col gap-4 rounded-3xl border border-ink-200 bg-white p-5 sm:p-6">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <h2 id={headingId} className="min-w-0 text-xl font-semibold break-words text-ink-950">
            <MetaLine as="span" parts={[item.studentName, item.readingTitle]} spoken={studentOnReading(item.studentName, item.readingTitle)} />
          </h2>
          <span className={`${pill} bg-warning-50 text-warning-900 text-base`}>
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-warning-500" /> {NO_NOTE_LABEL}
          </span>
        </div>
        <p className="text-lg text-ink-700 tabular-nums">{triesUsedLabel(item.tries, item.triesAllowed)}</p>
        <p className="text-lg text-ink-700">{noNoteHelp(item.studentName)}</p>
      </div>
      <form onSubmit={onSubmit} aria-busy={pending} className="flex flex-col gap-3">
        <input type="hidden" name="studentId" value={item.studentId} />
        <input type="hidden" name="readingId" value={item.readingId} />
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <Link href={answersHref} className={`${secondaryButton} self-start`}>
            See answers<span className="sr-only"> from {item.studentName} on {item.readingTitle}</span>
          </Link>
          <button type="submit" disabled={pending} className={`${secondaryButtonDisabled} self-start`}>
            {pending ? GIVE_EXTRA_TRY_PENDING : GIVE_EXTRA_TRY_LABEL}
            <span className="sr-only">
              {" "}
              for {item.studentName} on {item.readingTitle}
            </span>
          </button>
        </div>
        <ErrorMessage>{state.key === key ? state.error : ""}</ErrorMessage>
      </form>
    </li>
  );
}

function ChallengeCard({
  action,
  item,
  onDecided,
}: {
  action: Action;
  item: QueueItem;
  onDecided: (message: string) => void;
}) {
  const [running, setRunning] = useState<DecisionChoice | null>(null);
  const [state, dispatch, pending] = useActionState(async (prev: DecideState, formData: FormData) => {
    const next = await action(prev, formData);
    if (next.result) onDecided(decisionMessage(next.result, item.studentName));
    return next;
  }, {});

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const data = new FormData(e.currentTarget, submitter);
    const value = data.get("decision");
    setRunning(parseDecisionChoice(value) ? (value as DecisionChoice) : null);
    startTransition(() => dispatch(data));
  }

  const headingId = `challenge-${item.id}`;
  const noTry = item.lastTry === null;

  return (
    <li aria-labelledby={headingId} className="flex flex-col gap-5 rounded-3xl border border-ink-200 bg-white p-5 sm:p-6">
      <div className="flex flex-col gap-2">
        <h2 id={headingId} className="text-xl font-semibold break-words text-ink-950">
          <MetaLine as="span" parts={[item.studentName, item.readingTitle]} spoken={studentOnReading(item.studentName, item.readingTitle)} />
        </h2>
        <p className="flex flex-wrap items-center gap-2 text-lg text-ink-700">
          <span className={`${pill} bg-ink-100 text-ink-700 text-base tabular-nums`}>
            {triesUsedLabel(item.tries, item.triesAllowed)}
          </span>
          {item.round > 1 && (
            <span className={`${pill} bg-primary-50 text-primary-700 text-base`}>Note {item.noteNumber}, after one more try</span>
          )}
        </p>
      </div>

      <figure className="flex flex-col gap-1.5 rounded-2xl bg-primary-50/60 px-4 py-3">
        <figcaption className="text-lg font-semibold text-primary-900">Note from {item.studentName}</figcaption>
        <blockquote className="text-lg leading-relaxed whitespace-pre-line break-words text-ink-900">{item.note}</blockquote>
      </figure>

      <section aria-label={`${item.studentName}’s answers`} className="flex flex-col gap-3">
        <h3 className="text-lg font-semibold text-ink-700">
          {noTry ? "No answers were saved. Every check failed on our side." : `Answers from try ${item.lastTry}`}
        </h3>
        <ol className="flex flex-col gap-3">
          {item.questions.map((q) => (
            <li key={q.id} className="flex flex-col gap-2 rounded-2xl border border-ink-200 px-4 py-3">
              <p className="text-lg font-medium break-words text-ink-900">
                <span className="text-ink-700">{q.position}.</span> {q.prompt}
              </p>
              {q.answer ? (
                <>
                  <p className="rounded-xl bg-ink-50 px-3 py-2 text-lg leading-relaxed whitespace-pre-line break-words text-ink-900">
                    {q.answer.text}
                  </p>
                  <div className="flex flex-col items-start gap-1.5">
                    {q.answer.pass ? (
                      <span className={`${pill} bg-success-50 text-success-800 text-base`}>
                        <span aria-hidden="true">✓</span> AI check: pass
                      </span>
                    ) : (
                      <span className={`${pill} bg-warning-50 text-warning-900 text-base`}>
                        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-warning-500" /> AI check: not yet
                      </span>
                    )}
                    {!q.answer.pass && q.answer.nudge && (
                      <p className="text-lg text-ink-700">
                        <span className="font-semibold">Nudge shown: </span>
                        {q.answer.nudge}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                !noTry && <p className="text-lg text-ink-700">No answer saved.</p>
              )}
            </li>
          ))}
        </ol>
      </section>

      <form onSubmit={onSubmit} aria-busy={pending} className="flex flex-col gap-4 border-t border-ink-200 pt-5">
        <input type="hidden" name="challengeId" value={item.id} />
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <button type="submit" name="decision" value="accept" disabled={pending} className={primaryButton}>
            {pending && running === "accept" ? "Accepting…" : "Accept"}
            <span className="sr-only"> {item.studentName}’s answers</span>
          </button>
          <button type="submit" name="decision" value="deny" disabled={pending} className={secondaryButtonDisabled}>
            {pending && running === "deny" ? "Denying…" : "Deny"}
            <span className="sr-only"> {item.studentName}’s challenge</span>
          </button>
          <button
            type="submit"
            name="decision"
            value="deny_extra_try"
            disabled={pending}
            aria-describedby={`${headingId}-extra`}
            className={secondaryButtonDisabled}
          >
            {pending && running === "deny_extra_try" ? "Denying…" : "Deny, give one more try"}
            <span className="sr-only"> to {item.studentName}</span>
          </button>
        </div>
        <p id={`${headingId}-extra`} className="text-lg text-ink-700">
          One more try: {item.studentName} gets exactly 1 try back, and can send a new note if it doesn’t pass.
        </p>
        <ErrorMessage>
          {state.challengeId === item.id ? state.error : ""}
        </ErrorMessage>
      </form>
    </li>
  );
}
