import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { NeedsResetBadge, StudentReadingStatusBadge } from "@/components/student-reading-status-badge";
import { TeacherAnswerList } from "@/components/teacher-answers";
import { backLink, card, focusRing } from "@/components/ui";
import { cellKey, NOT_STARTED_CELL, triesLabel, type ClassStatus } from "@/lib/class-status";
import { loadClassStatus } from "@/lib/class-status-db";
import { STUDENT_GENERATION_CALL_LIMIT } from "@/lib/student-questions-core";
import { answersFor } from "@/lib/teacher-answers";
import { loadTeacherAnswers } from "@/lib/teacher-answers-db";
import { getOrCreateTeacher } from "@/lib/teacher";
import { loadClass } from "../../loaders";
import { resetTriesAction } from "../actions";
import { ProgressAnnouncer } from "../announcer";
import { ResetTriesButton } from "../reset-tries";
import { OpenBook } from "@/components/illustrations";

type Props = {
  params: Promise<{ id: string; studentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// Cached per request so generateMetadata and the page share one query.
const load = cache(async (id: string, studentId: string): Promise<{ status: ClassStatus; name: string; classId: string; className: string; teacherId: string }> => {
  const found = await loadClass(id);
  const teacher = await getOrCreateTeacher();
  const status = await loadClassStatus(found.id, teacher.id);
  const student = status.students.find((s) => s.id === studentId);
  if (!student) notFound();
  return { status, name: student.name, classId: found.id, className: found.name, teacherId: teacher.id };
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id, studentId } = await params;
  const { name } = await load(id, studentId);
  return { title: `${name}: Class progress` };
}

// One student's progress on each published reading, the same statuses as
// the class progress table, and (once they tried) See answers: each
// question's answer on every try, Passed or Not yet, and the latest tip. Where they Need a reset (every try at getting
// their own questions used, none came back), it says so in plain words,
// with "Let them try again". Only the owning teacher gets here (loadClass
// 404s others, and a student not in this class 404s); the reset checks
// ownership again in its own statement. `?reading=<id>` (from the
// challenge queue) opens that reading's answers.
export default async function StudentProgressPage({ params, searchParams }: Props) {
  const { id, studentId } = await params;
  const { reading: openReading } = await searchParams;
  const { status, name, classId, className, teacherId } = await load(id, studentId);
  const onReset = resetTriesAction.bind(null, classId);
  // Owner-scoped in the SQL (class + this teacher); the student is in
  // the class (load 404s otherwise).
  const answers = await loadTeacherAnswers(classId, teacherId, { studentId });

  return (
    <div className="flex flex-col gap-8">
      <Link href={`/teacher/classes/${classId}/students`} className={`${backLink} self-start`}>
        <span aria-hidden="true">←</span> <span className="break-words">Back to class progress</span>
      </Link>

      <div className="flex flex-col gap-1">
        <h1 id="student-heading" tabIndex={-1} className="text-3xl font-semibold tracking-tight break-words text-ink-950 focus:outline-none">
          {name}
        </h1>
        <p className="text-lg break-words text-ink-700">{className}</p>
      </div>

      <ProgressAnnouncer headingId="student-heading" />

      {status.readings.length === 0 ? (
        <div className={`${card} flex flex-col items-center gap-4 px-6 py-12 text-center`}>
          <OpenBook className="h-24 w-32" />
          <p className="text-lg text-ink-700">No published readings yet. Publish one, and progress shows up here.</p>
        </div>
      ) : (
        <ul className={`${card} divide-y divide-ink-200`}>
          {status.readings.map((r) => {
            const cell = status.cells[cellKey(studentId, r.id)] ?? NOT_STARTED_CELL;
            return (
              <li key={r.id} id={`reading-${r.id}`} className="flex scroll-mt-6 flex-col gap-3 px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <h2 className="min-w-0 text-base font-semibold break-words text-ink-950">{r.title}</h2>
                  {cell.needsReset ? (
                    <NeedsResetBadge size="sm" />
                  ) : (
                    <span className="flex items-center gap-3">
                      {cell.status !== "not_started" && (
                        <span className="text-base text-ink-700 tabular-nums">{triesLabel(cell)}</span>
                      )}
                      <StudentReadingStatusBadge audience="teacher" status={cell.status} size="sm" />
                    </span>
                  )}
                </div>
                {cell.tries > 0 && (
                  <details open={openReading === r.id} className="group rounded-2xl border border-ink-200 bg-ink-50">
                    <summary
                      className={`flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-4 py-2 text-base font-semibold text-primary-700 hover:bg-ink-100 [&::-webkit-details-marker]:hidden ${focusRing}`}
                    >
                      <span>
                        See answers<span className="sr-only"> for {r.title}</span>
                      </span>
                      <span aria-hidden="true" className="transition-transform group-open:rotate-90">
                        ›
                      </span>
                    </summary>
                    <div className="px-4 pt-1 pb-4">
                      <TeacherAnswerList questions={answersFor(answers, studentId, r.id)} headingLevel={3} />
                    </div>
                  </details>
                )}
                {cell.needsReset && (
                  <div className="flex flex-col items-start gap-3 rounded-xl bg-warning-50 px-4 py-3">
                    <p className="text-base text-ink-800">
                      {name}’s questions didn’t load after {STUDENT_GENERATION_CALL_LIMIT} tries, so they can’t try again
                      on their own. Let them try again to give them {STUDENT_GENERATION_CALL_LIMIT} more.
                    </p>
                    <ResetTriesButton
                      action={onReset}
                      studentId={studentId}
                      readingId={r.id}
                      name={name}
                      readingTitle={r.title}
                      size="base"
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
