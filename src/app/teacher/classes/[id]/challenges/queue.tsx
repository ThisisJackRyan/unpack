"use client";

import { startTransition, useActionState, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { pill, primaryButton, secondaryButton } from "@/components/ui";
import {
  decisionMessage,
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
import type { DecideState } from "./state";

type Action = (state: DecideState, formData: FormData) => Promise<DecideState>;

const secondaryButtonDisabled = `${secondaryButton} disabled:cursor-not-allowed disabled:opacity-60`;

// The queue, with one live region that stays mounted while cards come and
// go: after a decision the page refreshes, the card is gone, and the
// region still says what happened. Focus moves to the heading so it isn't
// lost with the card.
export function ChallengeQueue({ action, classId, entries }: { action: Action; classId: string; entries: QueueEntry[] }) {
  const [announcement, setAnnouncement] = useState("");
  const [focusHeading, setFocusHeading] = useState(0);

  useEffect(() => {
    if (focusHeading > 0) document.getElementById("queue-heading")?.focus();
  }, [focusHeading]);

  return (
    <>
      <p
        aria-live="polite"
        className="rounded-2xl border border-primary-200 bg-primary-50 px-5 py-3 text-base font-medium text-primary-950 empty:hidden"
      >
        {announcement}
      </p>
      {entries.length > 0 && (
        <ol className="flex flex-col gap-6">
          {entries.map((entry) =>
            entry.kind === "challenge" ? (
              <ChallengeCard
                key={entry.key}
                action={action}
                item={entry.item}
                onDecided={(message) => {
                  setAnnouncement(message);
                  setFocusHeading((n) => n + 1);
                }}
              />
            ) : (
              <NoNoteRow key={entry.key} classId={classId} item={entry.item} />
            ),
          )}
        </ol>
      )}
    </>
  );
}

// Out of tries, no note yet: one row, a short status line, and the way to
// their answers. Nothing to decide until a note comes.
function NoNoteRow({ classId, item }: { classId: string; item: NoNoteItem }) {
  const headingId = `no-note-${item.studentId}-${item.readingId}`;
  const answersHref = `/teacher/classes/${classId}/students/${item.studentId}?reading=${item.readingId}#reading-${item.readingId}`;
  return (
    <li aria-labelledby={headingId} className="flex flex-col gap-4 rounded-3xl border border-ink-200 bg-white p-5 sm:p-6">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <h2 id={headingId} className="min-w-0 text-xl font-semibold break-words text-ink-950">
            <MetaLine as="span" parts={[item.studentName, item.readingTitle]} />
          </h2>
          <span className={`${pill} bg-warning-50 text-warning-900 text-base`}>
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-warning-500" /> {NO_NOTE_LABEL}
          </span>
        </div>
        <p className="text-base text-ink-700 tabular-nums">{triesUsedLabel(item.tries, item.triesAllowed)}</p>
        <p className="text-base text-ink-700">{noNoteHelp(item.studentName)}</p>
      </div>
      <Link href={answersHref} className={`${secondaryButton} self-start`}>
        See answers<span className="sr-only"> from {item.studentName} on {item.readingTitle}</span>
      </Link>
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
          <MetaLine as="span" parts={[item.studentName, item.readingTitle]} />
        </h2>
        <p className="flex flex-wrap items-center gap-2 text-base text-ink-700">
          <span className={`${pill} bg-ink-100 text-ink-700 text-base tabular-nums`}>
            {triesUsedLabel(item.tries, item.triesAllowed)}
          </span>
          {item.round > 1 && (
            <span className={`${pill} bg-primary-50 text-primary-700 text-base`}>Note {item.round}, after one more try</span>
          )}
        </p>
      </div>

      <figure className="flex flex-col gap-1.5 rounded-2xl bg-primary-50/60 px-4 py-3">
        <figcaption className="text-base font-semibold text-primary-900">Note from {item.studentName}</figcaption>
        <blockquote className="text-lg leading-relaxed whitespace-pre-line break-words text-ink-900">{item.note}</blockquote>
      </figure>

      <section aria-label={`${item.studentName}’s answers`} className="flex flex-col gap-3">
        <h3 className="text-base font-semibold text-ink-700">
          {noTry ? "No answers were saved. Every check failed on our side." : `Answers from try ${item.lastTry}`}
        </h3>
        <ol className="flex flex-col gap-3">
          {item.questions.map((q) => (
            <li key={q.id} className="flex flex-col gap-2 rounded-2xl border border-ink-200 px-4 py-3">
              <p className="text-base font-medium break-words text-ink-900">
                <span className="text-ink-700">{q.position}.</span> {q.prompt}
              </p>
              {q.answer ? (
                <>
                  <p className="rounded-xl bg-ink-50 px-3 py-2 text-base leading-relaxed whitespace-pre-line break-words text-ink-900">
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
                      <p className="text-base text-ink-700">
                        <span className="font-semibold">Nudge shown: </span>
                        {q.answer.nudge}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                !noTry && <p className="text-base text-ink-700">No answer saved.</p>
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
        <p id={`${headingId}-extra`} className="text-base text-ink-700">
          One more try: {item.studentName} gets exactly 1 try back, and can send a new note if it doesn’t pass.
        </p>
        <ErrorMessage>
          {state.challengeId === item.id ? state.error : ""}
        </ErrorMessage>
      </form>
    </li>
  );
}
