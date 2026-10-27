import type { Metadata } from "next";
import Link from "next/link";
import { StudentReadingStatusBadge } from "@/components/student-reading-status-badge";
import { card, focusRing } from "@/components/ui";
import { questionCountLabel } from "@/lib/question-modes";
import type { StudentReadingListItem } from "@/lib/reading-progress";
import { listReadingsWithStatus } from "@/lib/reading-progress-db";
import { getStudentSession, requireStudentSession } from "@/lib/student-auth";

export async function generateMetadata(): Promise<Metadata> {
  const session = await getStudentSession();
  return { title: session?.class.name ?? "Your class" };
}

// The student's class home: their published readings, each with the
// student's status (Not started, In progress, Passed, Challenged). Already-joined
// students keep access even after the teacher turns the join code off;
// the code only gates joining.
export default async function StudentHomePage() {
  const session = await requireStudentSession();
  const readings = await listReadingsWithStatus(session.class.id, session.student.id);

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-1">
        <p className="text-lg font-medium break-words text-indigo-700">{session.class.name}</p>
        <h1 className="text-4xl font-semibold tracking-tight break-words text-zinc-950">
          Hi, {session.student.firstName}
        </h1>
      </div>

      <section aria-labelledby="readings-heading" className="flex flex-col gap-4">
        <h2 id="readings-heading" className="text-2xl font-semibold tracking-tight text-zinc-950">
          Readings
        </h2>
        {readings.length === 0 ? (
          <p className={`${card} rounded-2xl px-6 py-10 text-center text-lg text-zinc-600`}>
            No readings yet. Your teacher will add some soon.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {readings.map((r) => (
              <ReadingCard key={r.id} reading={r} />
            ))}
          </ul>
        )}
      </section>

      <p className="text-base text-zinc-600">
        Not {session.student.firstName}?{" "}
        <Link
          href="/join"
          className={`rounded font-semibold text-indigo-700 underline underline-offset-2 hover:text-indigo-900 ${focusRing}`}
        >
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
        className={`${card} flex min-h-20 items-center justify-between gap-4 rounded-2xl px-6 py-5 transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 ${focusRing}`}
      >
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-xl font-semibold break-words text-zinc-950">{reading.title}</span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <StudentReadingStatusBadge status={reading.status} />
            <span className="text-base text-zinc-600">{questionCountLabel(reading.questionCount)}</span>
          </span>
        </span>
        <span aria-hidden="true" className="text-2xl text-indigo-600">
          →
        </span>
      </Link>
    </li>
  );
}
