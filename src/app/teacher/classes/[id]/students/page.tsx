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
export default async function ClassProgressPage({ params }: Props) {
  const { id } = await params;
  const found = await loadClass(id);
  const teacher = await getOrCreateTeacher();
  const status = await loadClassStatus(found.id, teacher.id);
  const challengesHref = `/teacher/classes/${found.id}/challenges`;

  return (
    <div className="flex flex-col gap-8">
      <Link href={`/teacher/classes/${found.id}`} className={`${backLink} self-start`}>
        <span aria-hidden="true">←</span> <span className="break-words">Back to {found.name}</span>
      </Link>

      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950">Class progress</h1>
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

      {status.students.length === 0 || status.readings.length === 0 ? (
        <p className={`${card} px-6 py-12 text-center text-lg text-zinc-600`}>
          {status.students.length === 0
            ? "No students yet. Share the join code, and they’ll show up here."
            : "No published readings yet. Publish one, and progress shows up here."}
        </p>
      ) : (
        <>
          <ProgressTable status={status} />
          <ProgressCards status={status} />
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

function ProgressTable({ status }: { status: ClassStatus }) {
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProgressCards({ status }: { status: ClassStatus }) {
  return (
    <ul className="flex flex-col gap-3 md:hidden">
      {status.students.map((s) => (
        <li key={s.id} className={`${card} flex flex-col gap-3 px-5 py-4`}>
          <h2 className="text-lg font-semibold text-zinc-950">{s.name}</h2>
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
