import type { Metadata } from "next";
import Link from "next/link";
import { gradeLevelLabel } from "@/lib/grade-levels";
import { backLink, card } from "@/components/ui";
import { loadClass } from "../../loaders";
import { createReading } from "../actions";
import { ReadingForm } from "@/components/reading-form";

type Props = { params: Promise<{ id: string }> };

export const metadata: Metadata = {
  title: "Add a reading",
};

// The create action runs in this page's function: its lookups give up at
// PRE_WRITE_DEADLINE_MS (10s), a link fetch at FETCH_DEADLINE_MS (8s), then
// one insert and the redirect. 60 leaves room for those, and ends a hung
// request (a 504 the form shows as no reply, with everything kept) a lot
// sooner than the platform's default. src/lib/function-budget.test.ts adds
// it up.
export const maxDuration = 60;

export default async function NewReadingPage({ params }: Props) {
  const { id } = await params;
  const found = await loadClass(id);
  const classHref = `/teacher/classes/${found.id}`;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Link href={classHref} className={`${backLink} self-start`}>
        <span aria-hidden="true">←</span>{" "}
        <span className="break-words">Back to {found.name}</span>
      </Link>
      <h1 className="text-3xl font-semibold tracking-tight text-ink-950">
        Add a reading
      </h1>
      <div className={`${card} p-6 sm:p-8`}>
        <ReadingForm
          mode="create"
          action={createReading.bind(null, found.id)}
          classGradeLabel={gradeLevelLabel(found.gradeLevel)}
          classId={found.id}
          cancelHref={classHref}
        />
      </div>
    </div>
  );
}
