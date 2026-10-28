import { CheckIcon, LightbulbIcon, RetryIcon } from "@/components/answer-parts";
import { pill } from "@/components/ui";
import {
  ANSWER_NOT_YET_LABEL,
  ANSWER_PASSED_LABEL,
  keptLabel,
  latestTipLabel,
  NO_QUESTIONS_YET,
  NO_TRIES_YET,
  tryLabel,
  type TeacherAnswerQuestion,
} from "@/lib/teacher-answers";

// A student's answers on one reading, for their teacher: each question
// (a heading), its tries in order (a list, each with Passed or Not yet as
// an icon and a word, never color alone), and the latest tip the student
// was shown. A passed answer carried into a later try unchanged says
// "Kept from try N" instead of repeating the text. Read-only.
export function TeacherAnswerList({
  questions,
  headingLevel,
}: {
  questions: TeacherAnswerQuestion[];
  // The question headings' level, under the surrounding heading.
  headingLevel: 3 | 4;
}) {
  if (questions.length === 0) return <p className="text-lg text-ink-700">{NO_QUESTIONS_YET}</p>;
  if (questions.every((q) => q.tries.length === 0)) return <p className="text-lg text-ink-700">{NO_TRIES_YET}</p>;
  const Heading = headingLevel === 3 ? "h3" : "h4";
  return (
    <ol className="flex flex-col gap-3">
      {questions.map((q) => (
        <li key={q.id} className="flex flex-col gap-3 rounded-2xl border border-ink-200 bg-white p-4">
          <Heading className="text-lg font-semibold break-words text-ink-950">
            <span aria-hidden="true" className="text-ink-700 tabular-nums">
              {q.position}.{" "}
            </span>
            <span className="sr-only">Question {q.position}: </span>
            {q.prompt}
          </Heading>
          {q.tries.length === 0 ? (
            <p className="text-lg text-ink-700">No answer saved.</p>
          ) : (
            <ol aria-label={`Tries for question ${q.position}`} className="flex flex-col gap-2.5">
              {q.tries.map((t) => {
                const kept = keptLabel(t);
                return (
                  <li key={t.tryNumber} className="flex flex-col gap-1.5">
                    <p className="flex flex-wrap items-center gap-2 text-lg font-semibold text-ink-800">
                      {tryLabel(t)}
                      <AnswerStatus pass={t.pass} />
                      {kept && <span className="font-normal text-ink-700">{kept}</span>}
                    </p>
                    {!kept && (
                      <p className="rounded-xl bg-ink-50 px-3 py-2 text-lg leading-relaxed whitespace-pre-line break-words text-ink-900">
                        {t.text}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {q.latestTip && (
            <p className="flex gap-2 rounded-xl bg-warning-50 px-3 py-2 text-lg leading-relaxed text-warning-950">
              <LightbulbIcon className="mt-0.5 h-5 w-5 shrink-0 text-warning-700" />
              <span>
                <span className="font-semibold">{latestTipLabel(q.latestTip)}: </span>
                {q.latestTip.text}
              </span>
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

function AnswerStatus({ pass }: { pass: boolean }) {
  return pass ? (
    <span className={`${pill} bg-success-50 text-base text-success-800`}>
      <CheckIcon />
      {ANSWER_PASSED_LABEL}
    </span>
  ) : (
    <span className={`${pill} bg-warning-50 text-base text-warning-900`}>
      <RetryIcon />
      {ANSWER_NOT_YET_LABEL}
    </span>
  );
}
