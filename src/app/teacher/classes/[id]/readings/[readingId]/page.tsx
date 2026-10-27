import type { Metadata } from "next";
import Link from "next/link";
import { questionRole } from "@/lib/ai/prompts";
import { effectiveGradeLevel, gradeLevelLabel } from "@/lib/grade-levels";
import { questionCountLabel, questionModeLabel } from "@/lib/question-modes";
import { listSharedQuestions } from "@/lib/shared-questions-db";
import { sourceHost } from "@/lib/validate-reading";
import { ReadingStatusBadge } from "@/components/reading-status-badge";
import { backLink, card, focusRing, secondaryButton } from "@/components/ui";
import { loadReading } from "../../loaders";
import { questionAction } from "./question-actions";
import { QuestionNumber, QuestionsPanel, QuestionText } from "./questions-panel";

// Server actions on this page call the model: up to 2 attempts, each with
// one SDK retry, at 30 seconds a try (see src/lib/ai/settings.ts).
export const maxDuration = 150;

type Props = { params: Promise<{ id: string; readingId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id, readingId } = await params;
  const { reading } = await loadReading(id, readingId);
  return { title: reading.title };
}

export default async function ReadingPage({ params }: Props) {
  const { id, readingId } = await params;
  const { reading, class: found } = await loadReading(id, readingId);
  const classHref = `/teacher/classes/${found.id}`;
  const host = sourceHost(reading.sourceUrl);
  const paragraphs = reading.bodyText.split(/\n{2,}/);
  const shared = reading.questionMode === "shared";
  const questions = shared ? await listSharedQuestions(reading.id) : [];
  const gradeLabel = gradeLevelLabel(effectiveGradeLevel(reading.gradeLevel, found.gradeLevel));

  return (
    <div className="flex flex-col gap-8">
      <Link href={classHref} className={`${backLink} self-start`}>
        <span aria-hidden="true">←</span>{" "}
        <span className="break-words">Back to {found.name}</span>
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <ReadingStatusBadge status={reading.status} />
          <h1 className="text-3xl font-semibold tracking-tight break-words text-zinc-950">
            {reading.title}
          </h1>
        </div>
        <Link href={`${classHref}/readings/${reading.id}/edit`} className={secondaryButton}>
          {reading.status === "draft" ? "Edit" : "Edit title"}
        </Link>
      </div>

      <dl className={`${card} grid gap-x-6 gap-y-4 p-5 sm:grid-cols-2 sm:p-6`}>
        <Detail term="Grade level">
          {reading.gradeLevel
            ? gradeLevelLabel(reading.gradeLevel)
            : `Class grade (${gradeLevelLabel(found.gradeLevel)})`}
        </Detail>
        <Detail term="Questions">{reading.questionCount}</Detail>
        <Detail term="Question mode">{questionModeLabel(reading.questionMode)}</Detail>
        <Detail term="Source">
          {host && reading.sourceUrl ? (
            <a
              href={reading.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`rounded font-medium break-all text-indigo-700 underline underline-offset-2 hover:text-indigo-900 ${focusRing}`}
            >
              {host}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            "Pasted text"
          )}
        </Detail>
      </dl>

      <section aria-labelledby="questions-heading" className={`${card} p-5 sm:p-6`}>
        {reading.status === "draft" ? (
          <QuestionsPanel
            action={questionAction.bind(null, found.id, reading.id)}
            mode={reading.questionMode}
            questionCount={reading.questionCount}
            gradeLabel={gradeLabel}
            questions={questions}
          />
        ) : (
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex flex-col gap-1">
                <h2 id="questions-heading" className="text-xl font-semibold text-zinc-950">
                  Questions
                </h2>
                <p className="text-base text-zinc-600">
                  {questionCountLabel(reading.questionCount)} · Written for {gradeLabel}
                </p>
              </div>
              {shared && (
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-0.5 text-sm font-medium text-zinc-700">
                  <LockIcon />
                  Locked
                </span>
              )}
            </div>
            {shared ? (
              <>
                <ol className="flex flex-col gap-3" aria-label="Questions">
                  {questions.map((q) => (
                    <li key={q.id} className="flex gap-4 rounded-xl border border-zinc-200 bg-white p-4">
                      <QuestionNumber n={q.position} />
                      <QuestionText role={questionRole(q.position, reading.questionCount)} prompt={q.prompt} />
                    </li>
                  ))}
                </ol>
                <p className="text-sm text-zinc-500">
                  Questions are locked once a reading is published.
                </p>
              </>
            ) : (
              <p className="text-base text-zinc-700">
                Each student gets their own set when they first open this reading.
              </p>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="text-heading" className={`${card} px-6 py-8 sm:px-10 sm:py-10`}>
        <h2 id="text-heading" className="sr-only">
          Reading text
        </h2>
        <div className="mx-auto flex max-w-prose flex-col gap-5 text-lg leading-relaxed text-zinc-800">
          {paragraphs.map((p, i) => (
            <p key={i} className="whitespace-pre-line break-words">
              {p}
            </p>
          ))}
        </div>
      </section>
    </div>
  );
}

function Detail({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-sm font-medium text-zinc-500">{term}</dt>
      <dd className="text-base font-semibold text-zinc-950">{children}</dd>
    </div>
  );
}

function LockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
      <path d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 12 6h-.5V4.5A3.5 3.5 0 0 0 8 1Zm2 5H6V4.5a2 2 0 1 1 4 0V6Z" />
    </svg>
  );
}
