import type { Metadata } from "next";
import Link from "next/link";
import { gradeLevelLabel } from "@/lib/grade-levels";
import { backLink, card } from "@/components/ui";
import { loadClass } from "../../loaders";
import { createReading } from "../actions";
import { ReadingForm } from "../reading-form";

type Props = { params: Promise<{ id: string }> };

export const metadata: Metadata = {
  title: "Add a reading",
};

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
      <h1 className="text-3xl font-semibold tracking-tight text-zinc-950">
        Add a reading
      </h1>
      <div className={`${card} p-6 sm:p-8`}>
        <ReadingForm
          mode="create"
          action={createReading.bind(null, found.id)}
          classGradeLabel={gradeLevelLabel(found.gradeLevel)}
          cancelHref={classHref}
        />
      </div>
    </div>
  );
}
