import type { Metadata } from "next";
import Link from "next/link";
import { atClassLimit, listClasses } from "@/lib/classes";
import { gradeLevelLabel } from "@/lib/grade-levels";
import { getOrCreateTeacher } from "@/lib/teacher";
import { card, focusRing, primaryButton } from "@/components/ui";

export const metadata: Metadata = {
  title: "Your classes",
};

export default async function TeacherClassesPage() {
  const teacher = await getOrCreateTeacher();
  const classes = await listClasses(teacher.id);
  const limitReached = atClassLimit(teacher, classes.length);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950">
          Your classes
        </h1>
        {classes.length > 0 &&
          (limitReached ? (
            <p className="text-base text-zinc-600">Free plan includes 1 class</p>
          ) : (
            <Link href="/teacher/classes/new" className={primaryButton}>
              New class
            </Link>
          ))}
      </div>

      {classes.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className={`${card} divide-y divide-zinc-200 overflow-hidden`}>
          {classes.map((c) => (
            <li key={c.id}>
              <Link
                href={`/teacher/classes/${c.id}`}
                className={`flex min-h-16 items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-zinc-50 focus-visible:-outline-offset-2 ${focusRing}`}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-lg font-semibold text-zinc-950">
                    {c.name}
                  </span>
                  <span className="text-base text-zinc-600">
                    {gradeLevelLabel(c.gradeLevel)}
                  </span>
                </span>
                <span className="shrink-0 rounded-lg bg-zinc-100 px-3 py-1.5 font-mono text-base font-semibold tracking-widest text-zinc-900">
                  <span className="sr-only">Join code </span>
                  {c.joinCode}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div
      className={`${card} flex flex-col items-center gap-4 px-6 py-14 text-center`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 96 96"
        className="h-24 w-24"
        fill="none"
      >
        <circle cx="48" cy="48" r="44" fill="#eef2ff" />
        <path
          d="M24 34c8-4 16-4 24 2v32c-8-6-16-6-24-2V34Z"
          fill="#fff"
          stroke="#4f46e5"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        <path
          d="M72 34c-8-4-16-4-24 2v32c8-6 16-6 24-2V34Z"
          fill="#fff"
          stroke="#4f46e5"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        <path
          d="M30 44c4-1 8-1 12 1M30 52c4-1 8-1 12 1M54 45c4-2 8-2 12-1M54 53c4-2 8-2 12-1"
          stroke="#a5b4fc"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      <h2 className="text-xl font-semibold text-zinc-950">
        Create your first class
      </h2>
      <p className="max-w-sm text-base text-zinc-600">
        Students join with a short code. No accounts needed.
      </p>
      <Link
        href="/teacher/classes/new"
        className={`${primaryButton} mt-2 min-h-14 px-7 text-lg`}
      >
        Create a class
      </Link>
    </div>
  );
}
