import type { Metadata } from "next";
import Link from "next/link";
import { ReadingBuddy } from "@/components/illustrations";
import { atClassLimit, listClasses } from "@/lib/classes";
import { gradeLevelLabel } from "@/lib/grade-levels";
import { getOrCreateTeacher } from "@/lib/teacher";
import { card, focusRing, primaryButton, primaryButtonLarge } from "@/components/ui";

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
        <h1 className="text-3xl font-semibold tracking-tight text-ink-950">
          Your classes
        </h1>
        {classes.length > 0 &&
          (limitReached ? (
            <p className="text-base text-ink-700">Free plan includes 1 class</p>
          ) : (
            <Link href="/teacher/classes/new" className={primaryButton}>
              New class
            </Link>
          ))}
      </div>

      {classes.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className={`${card} divide-y divide-ink-200 overflow-hidden`}>
          {classes.map((c) => (
            <li key={c.id}>
              <Link
                href={`/teacher/classes/${c.id}`}
                className={`flex min-h-16 items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-ink-50 focus-visible:-outline-offset-2 ${focusRing}`}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-lg font-semibold text-ink-950">
                    {c.name}
                  </span>
                  <span className="text-base text-ink-700">
                    {gradeLevelLabel(c.gradeLevel)}
                  </span>
                </span>
                <span className="shrink-0 rounded-xl bg-ink-100 px-3 py-1.5 font-mono text-base font-semibold tracking-widest text-ink-900">
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
      <ReadingBuddy className="h-28 w-28" />
      <h2 className="text-xl font-semibold text-ink-950">
        Create your first class
      </h2>
      <p className="max-w-sm text-base text-ink-700">
        Students join with a short code. No accounts needed.
      </p>
      <Link
        href="/teacher/classes/new"
        className={`${primaryButtonLarge} mt-2`}
      >
        Create a class
      </Link>
    </div>
  );
}
