import type { Metadata } from "next";
import Link from "next/link";
import { NeedsResetBadge, StudentReadingStatusBadge } from "@/components/student-reading-status-badge";
import { backLink, card, focusRing } from "@/components/ui";
import {
  cellKey,
  NOT_STARTED_CELL,
  statusCounts,
  NEEDS_RESET_HELP,
  triesLabel,
  type ClassStatus,
  type ClassStatusCell,
  type ClassStatusReading,
  type ClassStatusStudent,
} from "@/lib/class-status";
import { loadClassStatus } from "@/lib/class-status-db";
import { getOrCreateTeacher } from "@/lib/teacher";
import { loadClass } from "../loaders";
import { deleteStudentAction, resetTriesAction } from "./actions";
import { ProgressAnnouncer } from "./announcer";
import { DeleteStudentButton } from "./delete-student";
import { ResetTriesButton } from "./reset-tries";
import type { DeleteStudentState, ResetTriesState } from "./state";
import { OpenBook, ReadingBuddy } from "@/components/illustrations";

type DeleteAction = (state: DeleteStudentState, formData: FormData) => Promise<DeleteStudentState>;
type ResetAction = (state: ResetTriesState, formData: FormData) => Promise<ResetTriesState>;
type Actions = { classId: string; onDelete: DeleteAction; onReset: ResetAction };

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const found = await loadClass(id);
  return { title: `Class progress: ${found.name}` };
}

// Each student on each published reading: Not started, In progress,
// Passed, Challenged, or Challenge denied, with tries used, or Needs a
// reset (with "Let them try again") when a student used every try at
// getting their own questions for a reading. A table on
// wide screens (students down, readings across), one card per student on
// narrow ones. Only the owning teacher gets here (loadClass 404s others).
// Each student has a Delete (with a confirm dialog) that removes them and
// all of their work; the delete checks ownership again in its own
// statement. Each name links to that student's own page.
export default async function ClassProgressPage({ params }: Props) {
  const { id } = await params;
  const found = await loadClass(id);
  const teacher = await getOrCreateTeacher();
  const status = await loadClassStatus(found.id, teacher.id);
  const challengesHref = `/teacher/classes/${found.id}/challenges`;
  const actions: Actions = {
    classId: found.id,
    onDelete: deleteStudentAction.bind(null, found.id),
    onReset: resetTriesAction.bind(null, found.id),
  };

  return (
    <div className="flex flex-col gap-8">
      <Link href={`/teacher/classes/${found.id}`} className={`${backLink} self-start`}>
        <span aria-hidden="true">←</span> <span className="break-words">Back to {found.name}</span>
      </Link>

      <div className="flex flex-col gap-1">
        <h1 id="progress-heading" tabIndex={-1} className="text-3xl font-semibold tracking-tight text-ink-950 focus:outline-none">
          Class progress
        </h1>
        <p className="text-lg text-ink-700">
          Each student on each published reading. Challenged readings wait for you in{" "}
          <Link
            href={challengesHref}
            className={`rounded font-semibold text-primary-700 underline underline-offset-2 hover:text-primary-900 ${focusRing}`}
          >
            Challenges
          </Link>
          .
        </p>
      </div>

      <ProgressAnnouncer headingId="progress-heading" />

      {status.students.length === 0 ? (
        <div className={`${card} flex flex-col items-center gap-4 px-6 py-12 text-center`}>
          <ReadingBuddy className="h-24 w-24" />
          <p className="text-lg text-ink-700">No students yet. Share the join code, and they’ll show up here.</p>
        </div>
      ) : status.readings.length === 0 ? (
        <>
          <div className={`${card} flex flex-col items-center gap-4 px-6 py-12 text-center`}>
            <OpenBook className="h-24 w-32" />
            <p className="text-lg text-ink-700">No published readings yet. Publish one, and progress shows up here.</p>
          </div>
          <StudentList status={status} actions={actions} />
        </>
      ) : (
        <>
          <ProgressTable status={status} actions={actions} />
          <ProgressCards status={status} actions={actions} />
        </>
      )}
    </div>
  );
}

function cellOf(status: ClassStatus, studentId: string, readingId: string): ClassStatusCell {
  return status.cells[cellKey(studentId, readingId)] ?? NOT_STARTED_CELL;
}

type CellTarget = { student: ClassStatusStudent; reading: ClassStatusReading; actions: Actions };

function Cell({ cell, target }: { cell: ClassStatusCell; target: CellTarget }) {
  if (cell.needsReset) {
    return (
      <span className="flex flex-col items-start gap-1.5">
        <NeedsResetBadge size="sm" />
        <span className="text-base text-ink-700">{NEEDS_RESET_HELP}</span>
        <ResetTriesButton
          action={target.actions.onReset}
          studentId={target.student.id}
          readingId={target.reading.id}
          name={target.student.name}
          readingTitle={target.reading.title}
        />
      </span>
    );
  }
  return (
    <span className="flex flex-col items-start gap-1">
      <StudentReadingStatusBadge status={cell.status} size="sm" />
      {cell.status !== "not_started" && (
        <span className="text-base text-ink-700 tabular-nums">{triesLabel(cell)}</span>
      )}
    </span>
  );
}

function StudentLink({ classId, student, className }: { classId: string; student: ClassStatusStudent; className: string }) {
  return (
    <Link
      href={`/teacher/classes/${classId}/students/${student.id}`}
      className={`rounded break-words underline-offset-2 hover:underline ${focusRing} ${className}`}
    >
      {student.name}
    </Link>
  );
}

// "4 of 12 passed", under each reading's title.
function passedSummary(status: ClassStatus, readingId: string): string {
  return `${statusCounts(status, readingId).passed} of ${status.students.length} passed`;
}

// Before any reading is published: just the names, each with Delete.
function StudentList({ status, actions }: { status: ClassStatus; actions: Actions }) {
  return (
    <section aria-labelledby="students-heading" className="flex flex-col gap-3">
      <h2 id="students-heading" className="text-xl font-semibold text-ink-950">
        Students
      </h2>
      <ul className={`${card} divide-y divide-ink-200`}>
        {status.students.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-4 px-5 py-2">
            <StudentLink classId={actions.classId} student={s} className="text-base font-semibold text-ink-950" />
            <DeleteStudentButton action={actions.onDelete} studentId={s.id} name={s.name} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ProgressTable({ status, actions }: { status: ClassStatus; actions: Actions }) {
  return (
    <div className={`${card} hidden overflow-x-auto md:block`}>
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">Each student’s status on each reading, with tries used</caption>
        <thead>
          <tr className="border-b border-ink-200 bg-ink-50">
            <th scope="col" className="sticky left-0 bg-ink-50 px-5 py-3 text-base font-semibold text-ink-700">
              Student
            </th>
            {status.readings.map((r) => (
              <th key={r.id} scope="col" className="min-w-40 px-4 py-3 align-bottom">
                <span className="line-clamp-2 text-base font-semibold text-ink-900">{r.title}</span>
                <span className="block text-base font-normal text-ink-700 tabular-nums">{passedSummary(status, r.id)}</span>
              </th>
            ))}
            <th scope="col" className="px-4 py-3">
              <span className="sr-only">Delete</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-200">
          {status.students.map((s) => (
            <tr key={s.id}>
              <th scope="row" className="sticky left-0 bg-white px-5 py-3 text-base font-semibold whitespace-nowrap text-ink-950">
                <StudentLink classId={actions.classId} student={s} className="" />
              </th>
              {status.readings.map((r) => (
                <td key={r.id} className="px-4 py-3 align-top">
                  <Cell cell={cellOf(status, s.id, r.id)} target={{ student: s, reading: r, actions }} />
                </td>
              ))}
              <td className="px-4 py-2 text-right align-top">
                <DeleteStudentButton action={actions.onDelete} studentId={s.id} name={s.name} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProgressCards({ status, actions }: { status: ClassStatus; actions: Actions }) {
  return (
    <ul className="flex flex-col gap-3 md:hidden">
      {status.students.map((s) => (
        <li key={s.id} className={`${card} flex flex-col gap-3 px-5 py-4`}>
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold text-ink-950">
              <StudentLink classId={actions.classId} student={s} className="" />
            </h2>
            <DeleteStudentButton action={actions.onDelete} studentId={s.id} name={s.name} />
          </div>
          <ul className="flex flex-col divide-y divide-ink-100">
            {status.readings.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-4 py-2.5">
                <span className="min-w-0 text-base break-words text-ink-800">{r.title}</span>
                <Cell cell={cellOf(status, s.id, r.id)} target={{ student: s, reading: r, actions }} />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
