import { card, focusRing, pill } from "@/components/ui";
import type { SavedAnswer } from "@/lib/reading-progress";
import type { StudentQuestion } from "@/lib/student-questions-core";

// Pieces shared by the answer form and the read-only answer views. A
// failed answer is a calm amber with an icon and a text label, never red
// (red is only for destructive actions), and never color alone.

export function CheckIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path
        fillRule="evenodd"
        d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

// A circle with an arrow going around: "have another go".
export function RetryIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.5 8A6 6 0 1 0 16 12M16 4v4h-4" />
    </svg>
  );
}

export function LightbulbIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} className={className}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7.5 15h5M8 17.5h4M10 2.5a5 5 0 0 0-3 9c.6.5 1 1.2 1 2V14h4v-.5c0-.8.4-1.5 1-2a5 5 0 0 0-3-9Z"
      />
    </svg>
  );
}

export function ResultBadge({ pass }: { pass: boolean }) {
  return pass ? (
    <span className={`${pill} bg-success-50 px-3 py-1 text-lg text-success-800`}>
      <CheckIcon />
      Looks good
    </span>
  ) : (
    <span className={`${pill} bg-warning-50 px-3 py-1 text-lg text-warning-900`}>
      <RetryIcon />
      Needs more
    </span>
  );
}

export function Nudge({ id, text }: { id?: string; text: string }) {
  return (
    <p id={id} className="flex gap-2.5 rounded-2xl bg-warning-50 px-4 py-3 text-lg leading-relaxed text-warning-950">
      <LightbulbIcon className="mt-1 h-5 w-5 shrink-0 text-warning-700" />
      <span>
        <span className="font-semibold">Tip: </span>
        {text}
      </span>
    </p>
  );
}

export function QuestionNumber({ position }: { position: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary-100 text-lg font-bold text-primary-800 tabular-nums"
    >
      {position}
    </span>
  );
}

// A question that passed on an earlier try: locked as done (the server
// won't take a new answer for it), shown read-only with its answer.
export function LockedAnswer({ question, text }: { question: StudentQuestion; text: string }) {
  return (
    <li className={`${card} flex flex-col gap-4 p-5 sm:p-6`}>
      <div className="flex gap-4">
        <QuestionNumber position={question.position} />
        <p className="pt-1.5 text-xl leading-relaxed font-semibold break-words text-ink-950">
          <span className="sr-only">Question {question.position}: </span>
          {question.prompt}
        </p>
      </div>
      <div className="flex flex-col items-start gap-3 sm:pl-14">
        <span className={`${pill} bg-success-50 px-3 py-1 text-lg text-success-800`}>
          <CheckIcon />
          Done
        </span>
        <p className="text-lg font-semibold text-ink-700">Your answer</p>
        <p className="w-full rounded-2xl bg-ink-50 px-4 py-3 text-lg leading-relaxed whitespace-pre-line break-words text-ink-900">
          {text}
        </p>
        <p className="text-lg text-ink-700">This one passed, so it’s done. No need to change it.</p>
      </div>
    </li>
  );
}

// The questions with a saved try's answers, read-only. `showResults` adds
// each answer's result and nudge (for a try that didn't pass).
export function AnswerReview({
  questions,
  answers,
  showResults,
}: {
  questions: StudentQuestion[];
  answers: Record<string, SavedAnswer>;
  showResults: boolean;
}) {
  return (
    <ol className="flex flex-col gap-3">
      {questions.map((q) => {
        const answer = answers[q.id];
        return (
          <li key={q.id} className={`${card} flex flex-col gap-4 p-5 sm:p-6`}>
            <div className="flex gap-4">
              <QuestionNumber position={q.position} />
              <p className="pt-1.5 text-xl leading-relaxed font-semibold break-words text-ink-950">
                <span className="sr-only">Question {q.position}: </span>
                {q.prompt}
              </p>
            </div>
            {answer && (
              <div className="flex flex-col gap-3 sm:pl-14">
                <p className="text-lg font-semibold text-ink-700">Your answer</p>
                <p className="rounded-2xl bg-ink-50 px-4 py-3 text-lg leading-relaxed whitespace-pre-line break-words text-ink-900">
                  {answer.text}
                </p>
                {showResults && (
                  <div className="flex flex-col items-start gap-3">
                    <ResultBadge pass={answer.pass} />
                    {!answer.pass && answer.nudge && <Nudge text={answer.nudge} />}
                  </div>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// "120 / 1,000", read out as "120 of 1,000 characters used".
export function CharacterCount({ id, length, max }: { id: string; length: number; max: number }) {
  const near = length >= max * 0.9;
  return (
    <p id={id} className={`text-lg tabular-nums ${near ? "font-medium text-warning-800" : "text-ink-700"}`}>
      <span aria-hidden="true">
        {length.toLocaleString("en-US")} / {max.toLocaleString("en-US")}
      </span>
      <span className="sr-only">
        {length.toLocaleString("en-US")} of {max.toLocaleString("en-US")} characters used
      </span>
    </p>
  );
}

export const answerBox = `block min-h-32 w-full resize-y rounded-2xl border-2 border-ink-400 bg-white px-4 py-3 text-lg leading-relaxed text-ink-950 aria-invalid:border-warning-600 aria-invalid:bg-warning-50/30 disabled:bg-ink-50 ${focusRing}`;

export const fieldError = "text-lg font-medium text-warning-900";

// For a button while its action runs.
export function Spinner() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="h-5 w-5 animate-spin motion-reduce:animate-none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
