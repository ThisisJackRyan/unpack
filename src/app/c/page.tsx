import type { Metadata } from "next";
import Link from "next/link";
import { StudentReadingStatusBadge } from "@/components/student-reading-status-badge";
import { OpenBook, ReadingBuddy } from "@/components/illustrations";
import { card, focusRing, textLink } from "@/components/ui";
import { MetaLine } from "@/components/meta-line";
import { doneLabel } from "@/lib/done-count";
import { questionCountLabel } from "@/lib/question-modes";
import type { StudentReadingListItem } from "@/lib/reading-progress";
import { listReadingsWithStatus } from "@/lib/reading-progress-db";
import { getStudentSession, requireStudentSession } from "@/lib/student-auth";

export async function generateMetadata(): Promise<Metadata> {
  const session = await getStudentSession();
  return { title: session?.class.name ?? "Your class" };
}

// The student's class home: their published readings, each with the
// student's status (Not started, In progress, Passed, Challenged, or
// Challenge denied). Already-joined students keep access even after the
// teacher turns the join code off; the code only gates joining.
export default async function StudentHomePage() {
  const session = await requireStudentSession();
  const readings = await listReadingsWithStatus(session.class.id, session.student.id);

  return (
    <div className="flex flex-col gap-10">
      <div className="flex items-center gap-5 rounded-3xl bg-primary-50 px-6 py-6 sm:px-8">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-lg font-semibold break-words text-primary-700">{session.class.name}</p>
          <h1 className="text-4xl font-bold tracking-tight break-words text-ink-950">
            Hi, {session.student.firstName}
          </h1>
        </div>
        <ReadingBuddy className="h-24 w-24 shrink-0 sm:h-28 sm:w-28" />
      </div>

      <section aria-labelledby="readings-heading" className="flex flex-col gap-4">
        <h2 id="readings-heading" className="text-2xl font-bold tracking-tight text-ink-950">
          Readings
        </h2>
        {readings.length === 0 ? (
          <div className={`${card} flex flex-col items-center gap-4 px-6 py-10 text-center`}>
            <OpenBook className="h-24 w-32" />
            <p className="text-lg text-ink-700">No readings yet. Your teacher will add some soon.</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {readings.map((r) => (
              <ReadingCard key={r.id} reading={r} />
            ))}
          </ul>
        )}
      </section>

      <p className="text-lg text-ink-700">
        Not {session.student.firstName}?{" "}
        <Link href="/join" className={textLink}>
          Join with your name
        </Link>
      </p>
    </div>
  );
}

function ReadingCard({ reading }: { reading: StudentReadingListItem }) {
  return (
    <li>
      <Link
        href={`/c/r/${reading.id}`}
        className={`${card} flex min-h-20 items-center justify-between gap-4 px-6 py-5 transition-colors hover:border-primary-300 hover:bg-primary-50 ${focusRing}`}
      >
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-xl font-bold break-words text-ink-950">{reading.title}</span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <StudentReadingStatusBadge status={reading.status} />
            <MetaLine
              as="span"
              className="text-lg text-ink-700"
              parts={[
                questionCountLabel(reading.questionCount),
                reading.status === "in_progress" && doneLabel(reading.passedAnswers, reading.questionCount),
              ]}
            />
          </span>
        </span>
        <span
          aria-hidden="true"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary-600 text-2xl font-bold text-white"
        >
          →
        </span>
      </Link>
    </li>
  );
}
