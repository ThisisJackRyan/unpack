import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { countOpenChallenges } from "@/lib/challenge-queue";
import { gradeLevelLabel } from "@/lib/grade-levels";
import { questionCountLabel, questionModeLabel } from "@/lib/question-modes";
import { listReadings, type ReadingListItem } from "@/lib/readings";
import { getOrCreateTeacher } from "@/lib/teacher";
import { ReadingStatusBadge } from "@/components/reading-status-badge";
import { backLink, card, focusRing, primaryButton } from "@/components/ui";
import { CopyButton } from "./copy-button";
import { newJoinCodeAction, setJoinCodeActiveAction } from "./join-code/actions";
import { JoinCodeSettings } from "./join-code/join-code-settings";
import { loadClass } from "./loaders";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const found = await loadClass(id);
  return { title: found.name };
}

export default async function ClassDetailPage({ params }: Props) {
  const { id } = await params;
  const found = await loadClass(id);
  const teacher = await getOrCreateTeacher();
  const [readings, openChallenges] = await Promise.all([
    listReadings(found.id, teacher.id),
    countOpenChallenges(found.id, teacher.id),
  ]);
  const newReadingHref = `/teacher/classes/${found.id}/readings/new`;
  const host = (await headers()).get("host");
  const joinUrl = host ? `${host}/join` : "/join";

  return (
    <div className="flex flex-col gap-8">
      <Link href="/teacher" className={`${backLink} self-start`}>
        <span aria-hidden="true">←</span> Back to classes
      </Link>

      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight break-words text-zinc-950">
          {found.name}
        </h1>
        <p className="text-lg text-zinc-600">
          {gradeLevelLabel(found.gradeLevel)}
        </p>
      </div>

      <nav aria-label="Class tools" className="grid gap-3 sm:grid-cols-2">
        <ToolLink
          href={`/teacher/classes/${found.id}/students`}
          title="Class progress"
          detail="Each student on each reading"
        />
        <ToolLink
          href={`/teacher/classes/${found.id}/challenges`}
          title="Challenges"
          detail={
            openChallenges === 0
              ? "Nothing waiting"
              : `${openChallenges} waiting for you`
          }
          count={openChallenges}
        />
      </nav>

      <section
        aria-labelledby="join-code-heading"
        className={`${card} flex flex-col items-center gap-6 px-6 pt-10 pb-4 text-center sm:pt-14`}
      >
        <div className="flex items-center gap-3">
          <h2
            id="join-code-heading"
            className="text-base font-semibold text-zinc-600"
          >
            Join code
          </h2>
          {found.codeActive ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2.5 py-0.5 text-sm font-medium text-indigo-700">
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-indigo-600" />
              Code is on
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-0.5 text-sm font-medium text-zinc-700">
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-zinc-400" />
              Code is off
            </span>
          )}
        </div>
        <p
          className={`pl-[0.2em] font-mono text-6xl font-bold tracking-[0.2em] sm:text-8xl ${
            found.codeActive ? "text-zinc-950" : "text-zinc-400"
          }`}
        >
          {found.joinCode}
        </p>
        <CopyButton value={found.joinCode} label="join code" />
        <p className="text-lg text-zinc-700">
          {found.codeActive ? (
            <>
              Students go to{" "}
              <span className="font-semibold text-zinc-950">{joinUrl}</span> and
              enter this code.
            </>
          ) : (
            "The code is off, so no one new can join. Turn it on below."
          )}
        </p>
        <div className="w-full max-w-xl">
          <JoinCodeSettings
            code={found.joinCode}
            codeActive={found.codeActive}
            setActiveAction={setJoinCodeActiveAction.bind(null, found.id)}
            newCodeAction={newJoinCodeAction.bind(null, found.id)}
          />
        </div>
      </section>

      <section aria-labelledby="readings-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2
            id="readings-heading"
            className="text-2xl font-semibold tracking-tight text-zinc-950"
          >
            Readings
          </h2>
          {readings.length > 0 && (
            <Link href={newReadingHref} className={primaryButton}>
              Add a reading
            </Link>
          )}
        </div>
        {readings.length === 0 ? (
          <ReadingsEmptyState href={newReadingHref} />
        ) : (
          <ul className={`${card} divide-y divide-zinc-200 overflow-hidden`}>
            {readings.map((r) => (
              <ReadingRow key={r.id} classId={found.id} reading={r} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ToolLink({
  href,
  title,
  detail,
  count,
}: {
  href: string;
  title: string;
  detail: string;
  count?: number;
}) {
  return (
    <Link
      href={href}
      className={`${card} flex min-h-20 items-center justify-between gap-4 px-5 py-4 transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 ${focusRing}`}
    >
      <span className="flex min-w-0 flex-col">
        <span className="flex items-center gap-2 text-lg font-semibold text-zinc-950">
          {title}
          {count !== undefined && count > 0 && (
            <span
              aria-hidden="true"
              className="inline-flex min-w-7 items-center justify-center rounded-full bg-indigo-600 px-2 py-0.5 text-sm font-semibold text-white tabular-nums"
            >
              {count}
            </span>
          )}
        </span>
        <span className="text-base text-zinc-600">{detail}</span>
      </span>
      <span aria-hidden="true" className="text-xl text-indigo-600">
        →
      </span>
    </Link>
  );
}

function ReadingRow({
  classId,
  reading,
}: {
  classId: string;
  reading: ReadingListItem;
}) {
  return (
    <li>
      <Link
        href={`/teacher/classes/${classId}/readings/${reading.id}`}
        className={`flex min-h-16 items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-zinc-50 focus-visible:-outline-offset-2 ${focusRing}`}
      >
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-lg font-semibold text-zinc-950">
            {reading.title}
          </span>
          <span className="text-base text-zinc-600">
            {questionCountLabel(reading.questionCount)}
            <span aria-hidden="true"> · </span>
            <span className="sr-only">, </span>
            {questionModeLabel(reading.questionMode)}
          </span>
        </span>
        <ReadingStatusBadge status={reading.status} />
      </Link>
    </li>
  );
}

function ReadingsEmptyState({ href }: { href: string }) {
  return (
    <div
      className={`${card} flex flex-col items-center gap-4 px-6 py-14 text-center`}
    >
      <svg aria-hidden="true" viewBox="0 0 96 96" className="h-24 w-24" fill="none">
        <circle cx="48" cy="48" r="44" fill="#eef2ff" />
        <rect
          x="28"
          y="22"
          width="40"
          height="52"
          rx="6"
          fill="#fff"
          stroke="#4f46e5"
          strokeWidth="3"
        />
        <path
          d="M36 36h24M36 45h24M36 54h16"
          stroke="#a5b4fc"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      <h3 className="text-xl font-semibold text-zinc-950">Add your first reading</h3>
      <p className="max-w-sm text-base text-zinc-600">
        Paste a link or some text. Students read it, then answer questions.
      </p>
      <Link href={href} className={`${primaryButton} mt-2 min-h-14 px-7 text-lg`}>
        Add a reading
      </Link>
    </div>
  );
}
