"use client";

import { startTransition, useActionState, useEffect, useState, type FormEvent } from "react";
import { focusRing, pill, primaryButton, secondaryButton } from "@/components/ui";
import { decisionMessage, type ChallengeDecision, type QueueItem } from "@/lib/challenge-queue-core";
import type { DecideState } from "./state";

type Action = (state: DecideState, formData: FormData) => Promise<DecideState>;

// The queue, with one live region that stays mounted while cards come and
// go: after a decision the page refreshes, the card is gone, and the
// region still says what happened. Focus moves to the heading so it isn't
// lost with the card.
export function ChallengeQueue({ action, items }: { action: Action; items: QueueItem[] }) {
  const [announcement, setAnnouncement] = useState("");
  const [focusHeading, setFocusHeading] = useState(0);

  useEffect(() => {
    if (focusHeading > 0) document.getElementById("queue-heading")?.focus();
  }, [focusHeading]);

  return (
    <>
      <p
        aria-live="polite"
        className="rounded-xl border border-indigo-200 bg-indigo-50 px-5 py-3 text-base font-medium text-indigo-950 empty:hidden"
      >
        {announcement}
      </p>
      {items.length > 0 && (
        <ol className="flex flex-col gap-6">
          {items.map((item) => (
            <ChallengeCard
              key={item.id}
              action={action}
              item={item}
              onDecided={(message) => {
                setAnnouncement(message);
                setFocusHeading((n) => n + 1);
              }}
            />
          ))}
        </ol>
      )}
    </>
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
  const [running, setRunning] = useState<ChallengeDecision | null>(null);
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
    setRunning(data.get("decision") === "accept" ? "accept" : "deny");
    startTransition(() => dispatch(data));
  }

  const headingId = `challenge-${item.id}`;
  const noTry = item.lastTry === null;

  return (
    <li aria-labelledby={headingId} className="flex flex-col gap-5 rounded-2xl border border-zinc-200 bg-white p-5 sm:p-6">
      <div className="flex flex-col gap-2">
        <h2 id={headingId} className="text-xl font-semibold break-words text-zinc-950">
          {item.studentName}
          <span className="text-zinc-400" aria-hidden="true">
            {" "}
            ·{" "}
          </span>
          <span className="sr-only">, </span>
          <span className="font-medium text-zinc-700">{item.readingTitle}</span>
        </h2>
        <p className="flex flex-wrap items-center gap-2 text-sm text-zinc-600">
          <span className={`${pill} bg-zinc-100 text-zinc-700 tabular-nums`}>
            {item.tries} of {item.triesAllowed} {item.triesAllowed === 1 ? "try" : "tries"} used
          </span>
          <span className={`${pill} bg-zinc-100 text-zinc-700 tabular-nums`}>
            {item.checks} of {item.checksAllowed} checks used
          </span>
          {item.round > 1 && (
            <span className={`${pill} bg-indigo-50 text-indigo-700`}>Note {item.round}, after one more try</span>
          )}
        </p>
      </div>

      <figure className="flex flex-col gap-1.5 rounded-xl bg-indigo-50/60 px-4 py-3">
        <figcaption className="text-sm font-semibold text-indigo-900">Note from {item.studentName}</figcaption>
        <blockquote className="text-lg leading-relaxed whitespace-pre-line break-words text-zinc-900">{item.note}</blockquote>
      </figure>

      <section aria-label={`${item.studentName}’s answers`} className="flex flex-col gap-3">
        <h3 className="text-base font-semibold text-zinc-700">
          {noTry ? "No answers were saved. Every check failed on our side." : `Answers from try ${item.lastTry}`}
        </h3>
        <ol className="flex flex-col gap-3">
          {item.questions.map((q) => (
            <li key={q.id} className="flex flex-col gap-2 rounded-xl border border-zinc-200 px-4 py-3">
              <p className="text-base font-medium break-words text-zinc-900">
                <span className="text-zinc-500">{q.position}.</span> {q.prompt}
              </p>
              {q.answer ? (
                <>
                  <p className="rounded-lg bg-zinc-50 px-3 py-2 text-base leading-relaxed whitespace-pre-line break-words text-zinc-900">
                    {q.answer.text}
                  </p>
                  <div className="flex flex-col items-start gap-1.5">
                    {q.answer.pass ? (
                      <span className={`${pill} bg-emerald-50 text-emerald-800`}>
                        <span aria-hidden="true">✓</span> AI check: pass
                      </span>
                    ) : (
                      <span className={`${pill} bg-amber-50 text-amber-900`}>
                        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-amber-500" /> AI check: not yet
                      </span>
                    )}
                    {!q.answer.pass && q.answer.nudge && (
                      <p className="text-sm text-zinc-700">
                        <span className="font-semibold">Nudge shown: </span>
                        {q.answer.nudge}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                !noTry && <p className="text-sm text-zinc-500">No answer saved.</p>
              )}
            </li>
          ))}
        </ol>
      </section>

      <form onSubmit={onSubmit} aria-busy={pending} className="flex flex-col gap-4 border-t border-zinc-200 pt-5">
        <input type="hidden" name="challengeId" value={item.id} />
        <label className="flex items-start gap-3 text-base text-zinc-800">
          <input
            type="checkbox"
            name="extraTry"
            disabled={pending}
            aria-describedby={`${headingId}-extra`}
            className={`mt-1 h-5 w-5 shrink-0 rounded border-zinc-400 accent-indigo-600 ${focusRing}`}
          />
          <span className="flex flex-col">
            <span className="font-semibold">Give one more try</span>
            <span id={`${headingId}-extra`} className="text-sm text-zinc-600">
              With Deny: {item.studentName} gets exactly 1 try back, and can send a new note if it doesn’t pass.
            </span>
          </span>
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <button type="submit" name="decision" value="accept" disabled={pending} className={primaryButton}>
            {pending && running === "accept" ? "Accepting…" : "Accept"}
            <span className="sr-only"> {item.studentName}’s answers</span>
          </button>
          <button
            type="submit"
            name="decision"
            value="deny"
            disabled={pending}
            className={`${secondaryButton} disabled:cursor-not-allowed disabled:opacity-60`}
          >
            {pending && running === "deny" ? "Denying…" : "Deny"}
            <span className="sr-only"> {item.studentName}’s challenge</span>
          </button>
        </div>
        <p aria-live="polite" className="text-base font-medium text-amber-900 empty:hidden">
          {state.challengeId === item.id ? state.error : ""}
        </p>
      </form>
    </li>
  );
}
