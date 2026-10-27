import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { backLink, card } from "@/components/ui";
import { questionCountLabel } from "@/lib/question-modes";
import { getStudentSession, requireStudentSession } from "@/lib/student-auth";
import type { StudentQuestion } from "@/lib/student-questions-core";
import { PENDING_MAX_REFRESHES } from "@/lib/student-reading-view";
import { getPublishedReading, loadStudentReading } from "@/lib/student-readings";
import { PendingRefresh, RetryButton } from "./refresh";
import { QuestionSkeletons } from "./skeleton";

// A student's first open of a unique per student reading writes their set,
// which QUESTION_WRITE_DEADLINE_MS (110s, in src/lib/ai/settings.ts) ends
// at the latest, attempts and retries included. 150 leaves room for the
// lookups and the commit, the same budget as the teacher reading page.
export const maxDuration = 150;

type Props = { params: Promise<{ readingId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { readingId } = await params;
  const session = await getStudentSession();
  const reading = session && (await getPublishedReading(session.class.id, readingId));
  return { title: reading ? reading.title : "Reading" };
}

// Shows the reading's title and the student's questions. The reading text
// itself waits for the read view (copy and paste blocked, a later PR), and
// answering comes after that.
export default async function StudentReadingPage({ params }: Props) {
  const { readingId } = await params;
  const session = await requireStudentSession();
  const { reading, view } = await loadStudentReading(session, readingId);
  if (!reading) notFound();

  return (
    <div className="flex flex-col gap-8">
      <Link href="/c" className={`${backLink} self-start text-lg`}>
        <span aria-hidden="true">←</span> <span className="break-words">Back to {session.class.name}</span>
      </Link>

      <div className="flex flex-col gap-2">
        <p className="text-lg text-zinc-600">{questionCountLabel(reading.questionCount)}</p>
        <h1 className="text-4xl font-semibold tracking-tight break-words text-zinc-950">{reading.title}</h1>
      </div>

      {view.kind === "questions" && (
        <section aria-labelledby="questions-heading" className="flex flex-col gap-5">
          <h2 id="questions-heading" className="text-2xl font-semibold tracking-tight text-zinc-950">
            Your questions
          </h2>
          <p className="rounded-2xl bg-indigo-50 px-5 py-4 text-lg text-indigo-900">
            Answering comes next. For now, read the questions.
          </p>
          <QuestionList questions={view.questions} />
        </section>
      )}

      {view.kind === "pending" && (
        <PendingRefresh retryAfterMs={view.retryAfterMs} maxTries={PENDING_MAX_REFRESHES}>
          <QuestionSkeletons count={reading.questionCount} />
        </PendingRefresh>
      )}

      {view.kind === "limit_reached" && (
        <p className={`${card} rounded-2xl px-6 py-10 text-center text-lg text-zinc-700`}>{view.message}</p>
      )}

      {view.kind === "error" && (
        <div className={`${card} flex flex-col items-start gap-5 rounded-2xl p-6`}>
          <p aria-live="polite" className="text-lg text-zinc-700">
            {view.message}
          </p>
          <RetryButton />
        </div>
      )}
    </div>
  );
}

function QuestionList({ questions }: { questions: StudentQuestion[] }) {
  return (
    <ol className="flex flex-col gap-3">
      {questions.map((q) => (
        <li key={q.id} className="flex gap-4 rounded-2xl border border-zinc-200 bg-white p-5">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-lg font-semibold text-indigo-700 tabular-nums"
          >
            {q.position}
          </span>
          <p className="pt-1.5 text-lg leading-relaxed break-words text-zinc-900">
            <span className="sr-only">Question {q.position}: </span>
            {q.prompt}
          </p>
        </li>
      ))}
    </ol>
  );
}
