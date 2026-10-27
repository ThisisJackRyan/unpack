import type { Metadata } from "next";
import Link from "next/link";
import { gradeLevelLabel } from "@/lib/grade-levels";
import { sourceHost } from "@/lib/validate-reading";
import { backLink, card } from "@/components/ui";
import { loadReading } from "../../../loaders";
import { updateReading } from "../../actions";
import { ReadingForm } from "../../reading-form";

type Props = { params: Promise<{ id: string; readingId: string }> };

export const metadata: Metadata = {
  title: "Edit reading",
};

export default async function EditReadingPage({ params }: Props) {
  const { id, readingId } = await params;
  const { reading, class: found } = await loadReading(id, readingId);
  const readingHref = `/teacher/classes/${found.id}/readings/${reading.id}`;
  const published = reading.status === "published";

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Link href={readingHref} className={`${backLink} self-start`}>
        <span aria-hidden="true">←</span> Back to reading
      </Link>
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950">
          {published ? "Edit title" : "Edit reading"}
        </h1>
        <p className="text-base text-zinc-600">
          {published
            ? "This reading is published, so only its title can be changed."
            : "Changing the text, grade level, number of questions, or mode clears the questions."}
        </p>
      </div>
      <div className={`${card} p-6 sm:p-8`}>
        <ReadingForm
          mode={published ? "title" : "edit"}
          action={updateReading.bind(null, found.id, reading.id)}
          classGradeLabel={gradeLevelLabel(found.gradeLevel)}
          cancelHref={readingHref}
          sourceHost={sourceHost(reading.sourceUrl)}
          initialValues={{
            source: "text",
            url: "",
            title: reading.title,
            bodyText: reading.bodyText,
            gradeLevel: reading.gradeLevel ?? "",
            questionCount: String(reading.questionCount),
            questionMode: reading.questionMode,
          }}
        />
      </div>
    </div>
  );
}
