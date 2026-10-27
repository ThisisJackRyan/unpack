import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { countOpenChallenges } from "@/lib/challenge-queue";
import { countDraftsClearedByGradeChange } from "@/lib/classes";
import { READING_DELETED_FLAG, READING_DELETED_MESSAGE } from "@/lib/reading-delete";
import { gradeLevelLabel } from "@/lib/grade-levels";
import { questionCountLabel, questionModeLabel } from "@/lib/question-modes";
import type { CapBadge as CapBadgeData } from "@/lib/reading-cap";
import { getClassCapBadges, listReadings, type ReadingListItem } from "@/lib/readings";
import { getOrCreateTeacher } from "@/lib/teacher";
import { CapBadge } from "@/components/cap-badge";
import { ReadingStatusBadge } from "@/components/reading-status-badge";
import { backLink, card, focusRing, primaryButton, primaryButtonLarge } from "@/components/ui";
import { saveClassSettingsAction } from "./class-settings/actions";
import { ClassSettingsForm } from "./class-settings/class-settings-form";
import { CopyButton } from "./copy-button";
import { newJoinCodeAction, setJoinCodeActiveAction } from "./join-code/actions";
import { JoinCodeSettings } from "./join-code/join-code-settings";
import { loadClass } from "./loaders";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const found = await loadClass(id);
  return { title: found.name };
}

export default async function ClassDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { notice } = await searchParams;
  const found = await loadClass(id);
  const teacher = await getOrCreateTeacher();
  const [readings, openChallenges, draftsToClear, capBadges] = await Promise.all([
    listReadings(found.id, teacher.id),
    countOpenChallenges(found.id, teacher.id),
    countDraftsClearedByGradeChange(found.id, teacher.id),
    getClassCapBadges(found.id, teacher.id),
  ]);
  const readingDeleted = notice === READING_DELETED_FLAG;
  const newReadingHref = `/teacher/classes/${found.id}/readings/new`;
  const host = (await headers()).get("host");
  const joinUrl = host ? `${host}/join` : "/join";

  return (
    <div className="flex flex-col gap-8">
      <Link href="/teacher" className={`${backLink} self-start`}>
        <span aria-hidden="true">←</span> Back to classes
      </Link>

      {readingDeleted && (
        <p
          role="status"
          className="rounded-xl border border-primary-200 bg-primary-50 px-5 py-3 text-base font-medium text-primary-950"
        >
          {READING_DELETED_MESSAGE}
        </p>
      )}

      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight break-words text-ink-950">
          {found.name}
        </h1>
        <p className="text-lg text-ink-600">
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
            className="text-base font-semibold text-ink-600"
          >
            Join code
          </h2>
          {found.codeActive ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-50 px-2.5 py-0.5 text-sm font-medium text-primary-700">
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-primary-600" />
              Code is on
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-ink-100 px-2.5 py-0.5 text-sm font-medium text-ink-700">
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-ink-400" />
              Code is off
            </span>
          )}
        </div>
        <p
          className={`pl-[0.2em] font-mono text-6xl font-bold tracking-[0.2em] sm:text-8xl ${
            found.codeActive ? "text-ink-950" : "text-ink-400"
          }`}
        >
          {found.joinCode}
        </p>
        <CopyButton value={found.joinCode} label="join code" />
        <p className="text-lg text-ink-700">
          {found.codeActive ? (
            <>
              Students go to{" "}
              <span className="font-semibold text-ink-950">{joinUrl}</span> and
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
            className="text-2xl font-semibold tracking-tight text-ink-950"
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
          <ul className={`${card} divide-y divide-ink-200 overflow-hidden`}>
            {readings.map((r) => (
              <ReadingRow key={r.id} classId={found.id} reading={r} capBadge={capBadges.get(r.id)} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="class-settings-heading" className={`${card} flex flex-col gap-5 p-5 sm:p-6`}>
        <div className="flex flex-col gap-1">
          <h2 id="class-settings-heading" className="text-2xl font-semibold tracking-tight text-ink-950">
            Class settings
          </h2>
          <p className="text-base text-ink-600">The class’s name and the grade its questions are written for.</p>
        </div>
        <ClassSettingsForm
          name={found.name}
          gradeLevel={found.gradeLevel}
          draftsToClear={draftsToClear}
          action={saveClassSettingsAction.bind(null, found.id)}
        />
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
      className={`${card} flex min-h-20 items-center justify-between gap-4 px-5 py-4 transition-colors hover:border-primary-300 hover:bg-primary-50/40 ${focusRing}`}
    >
      <span className="flex min-w-0 flex-col">
        <span className="flex items-center gap-2 text-lg font-semibold text-ink-950">
          {title}
          {count !== undefined && count > 0 && (
            <span
              aria-hidden="true"
              className="inline-flex min-w-7 items-center justify-center rounded-full bg-primary-600 px-2 py-0.5 text-sm font-semibold text-white tabular-nums"
            >
              {count}
            </span>
          )}
        </span>
        <span className="text-base text-ink-600">{detail}</span>
      </span>
      <span aria-hidden="true" className="text-xl text-primary-600">
        →
      </span>
    </Link>
  );
}

function ReadingRow({
  classId,
  reading,
  capBadge,
}: {
  classId: string;
  reading: ReadingListItem;
  capBadge?: CapBadgeData;
}) {
  return (
    <li>
      <Link
        href={`/teacher/classes/${classId}/readings/${reading.id}`}
        className={`flex min-h-16 items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-ink-50 focus-visible:-outline-offset-2 ${focusRing}`}
      >
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-lg font-semibold text-ink-950">
            {reading.title}
          </span>
          <span className="text-base text-ink-600">
            {questionCountLabel(reading.questionCount)}
            <span aria-hidden="true"> · </span>
            <span className="sr-only">, </span>
            {questionModeLabel(reading.questionMode)}
          </span>
        </span>
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {capBadge && <CapBadge badge={capBadge} />}
          <ReadingStatusBadge status={reading.status} />
        </span>
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
      <h3 className="text-xl font-semibold text-ink-950">Add your first reading</h3>
      <p className="max-w-sm text-base text-ink-600">
        Paste a link or some text. Students read it, then answer questions.
      </p>
      <Link href={href} className={`${primaryButtonLarge} mt-2`}>
        Add a reading
      </Link>
    </div>
  );
}
