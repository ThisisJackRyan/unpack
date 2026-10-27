import type { Metadata } from "next";
import Link from "next/link";
import { StudentReadingStatusBadge } from "@/components/student-reading-status-badge";
import { backLink, card, focusRing } from "@/components/ui";
import {
  cellKey,
  NOT_STARTED_CELL,
  statusCounts,
  triesLabel,
  type ClassStatus,
  type ClassStatusCell,
} from "@/lib/class-status";
import { loadClassStatus } from "@/lib/class-status-db";
import { getOrCreateTeacher } from "@/lib/teacher";
import { loadClass } from "../loaders";
import { deleteStudentAction } from "./actions";
import { DeleteAnnouncer, DeleteStudentButton } from "./delete-student";
import type { DeleteStudentState } from "./state";

type DeleteAction = (state: DeleteStudentState, formData: FormData) => Promise<DeleteStudentState>;

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const found = await loadClass(id);
  return { title: `Class progress: ${found.name}` };
}

// Each student on each published reading: Not started, In progress,
// Passed, Challenged, or Challenge denied, with tries used. A table on
// wide screens (students down, readings across), one card per student on
// narrow ones. Only the owning teacher gets here (loadClass 404s others).
// Each student has a Delete (with a confirm dialog) that removes them and
// all of their work; the delete checks ownership again in its own
// statement.
export default async function ClassProgressPage({ params }: Props) {
  const { id } = await params;
  const found = await loadClass(id);
  const teacher = await getOrCreateTeacher();
  const status = await loadClassStatus(found.id, teacher.id);
  const challengesHref = `/teacher/classes/${found.id}/challenges`;
  const onDelete = deleteStudentAction.bind(null, found.id);

  return (
    <div className="flex flex-col gap-8">
      <Link href={`/teacher/classes/${found.id}`} className={`${backLink} self-start`}>
        <span aria-hidden="true">←</span> <span className="break-words">Back to {found.name}</span>
      </Link>

      <div className="flex flex-col gap-1">
        <h1 id="progress-heading" tabIndex={-1} className="text-3xl font-semibold tracking-tight text-zinc-950 focus:outline-none">
          Class progress
        </h1>
        <p className="text-lg text-zinc-600">
          Each student on each published reading. Challenged readings wait for you in{" "}
          <Link
            href={challengesHref}
            className={`rounded font-semibold text-indigo-700 underline underline-offset-2 hover:text-indigo-900 ${focusRing}`}
          >
            Challenges
          </Link>
          .
        </p>
      </div>

      <DeleteAnnouncer headingId="progress-heading" />

      {status.students.length === 0 ? (
        <p className={`${card} px-6 py-12 text-center text-lg text-zinc-600`}>
          No students yet. Share the join code, and they’ll show up here.
        </p>
      ) : status.readings.length === 0 ? (
        <>
          <p className={`${card} px-6 py-12 text-center text-lg text-zinc-600`}>
            No published readings yet. Publish one, and progress shows up here.
          </p>
          <StudentList status={status} onDelete={onDelete} />
        </>
      ) : (
        <>
          <ProgressTable status={status} onDelete={onDelete} />
          <ProgressCards status={status} onDelete={onDelete} />
        </>
      )}
    </div>
  );
}

function cellOf(status: ClassStatus, studentId: string, readingId: string): ClassStatusCell {
  return status.cells[cellKey(studentId, readingId)] ?? NOT_STARTED_CELL;
}

function Cell({ cell }: { cell: ClassStatusCell }) {
  return (
    <span className="flex flex-col items-start gap-1">
      <StudentReadingStatusBadge status={cell.status} size="sm" />
      {cell.status !== "not_started" && (
        <span className="text-sm text-zinc-600 tabular-nums">{triesLabel(cell)}</span>
      )}
    </span>
  );
}

// "4 of 12 passed", under each reading's title.
function passedSummary(status: ClassStatus, readingId: string): string {
  return `${statusCounts(status, readingId).passed} of ${status.students.length} passed`;
}

// Before any reading is published: just the names, each with Delete.
function StudentList({ status, onDelete }: { status: ClassStatus; onDelete: DeleteAction }) {
  return (
    <section aria-labelledby="students-heading" className="flex flex-col gap-3">
      <h2 id="students-heading" className="text-xl font-semibold text-zinc-950">
        Students
      </h2>
      <ul className={`${card} divide-y divide-zinc-200`}>
        {status.students.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-4 px-5 py-2">
            <span className="text-base font-semibold break-words text-zinc-950">{s.name}</span>
            <DeleteStudentButton action={onDelete} studentId={s.id} name={s.name} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ProgressTable({ status, onDelete }: { status: ClassStatus; onDelete: DeleteAction }) {
  return (
    <div className={`${card} hidden overflow-x-auto md:block`}>
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">Each student’s status on each reading, with tries used</caption>
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50">
            <th scope="col" className="sticky left-0 bg-zinc-50 px-5 py-3 text-sm font-semibold text-zinc-600">
              Student
            </th>
            {status.readings.map((r) => (
              <th key={r.id} scope="col" className="min-w-40 px-4 py-3 align-bottom">
                <span className="line-clamp-2 text-sm font-semibold text-zinc-900">{r.title}</span>
                <span className="block text-sm font-normal text-zinc-500 tabular-nums">{passedSummary(status, r.id)}</span>
              </th>
            ))}
            <th scope="col" className="px-4 py-3">
              <span className="sr-only">Delete</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200">
          {status.students.map((s) => (
            <tr key={s.id}>
              <th scope="row" className="sticky left-0 bg-white px-5 py-3 text-base font-semibold whitespace-nowrap text-zinc-950">
                {s.name}
              </th>
              {status.readings.map((r) => (
                <td key={r.id} className="px-4 py-3 align-top">
                  <Cell cell={cellOf(status, s.id, r.id)} />
                </td>
              ))}
              <td className="px-4 py-2 text-right align-top">
                <DeleteStudentButton action={onDelete} studentId={s.id} name={s.name} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProgressCards({ status, onDelete }: { status: ClassStatus; onDelete: DeleteAction }) {
  return (
    <ul className="flex flex-col gap-3 md:hidden">
      {status.students.map((s) => (
        <li key={s.id} className={`${card} flex flex-col gap-3 px-5 py-4`}>
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold break-words text-zinc-950">{s.name}</h2>
            <DeleteStudentButton action={onDelete} studentId={s.id} name={s.name} />
          </div>
          <ul className="flex flex-col divide-y divide-zinc-100">
            {status.readings.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-4 py-2.5">
                <span className="min-w-0 text-base break-words text-zinc-800">{r.title}</span>
                <Cell cell={cellOf(status, s.id, r.id)} />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
