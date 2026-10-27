import type { Metadata } from "next";
import Link from "next/link";
import { gradeLevelLabel } from "@/lib/grade-levels";
import { sourceHost } from "@/lib/validate-reading";
import { backLink, card, secondaryButton } from "@/components/ui";
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

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Link href={readingHref} className={`${backLink} self-start`}>
        <span aria-hidden="true">←</span> Back to reading
      </Link>
      {reading.status !== "draft" ? (
        <div className={`${card} flex flex-col items-center gap-3 px-6 py-12 text-center`}>
          <h1 className="text-2xl font-semibold text-zinc-950">
            This reading is published
          </h1>
          <p className="text-base text-zinc-600">Only drafts can be edited.</p>
          <Link href={readingHref} className={`${secondaryButton} mt-3`}>
            Back to reading
          </Link>
        </div>
      ) : (
        <>
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-950">
            Edit reading
          </h1>
          <div className={`${card} p-6 sm:p-8`}>
            <ReadingForm
              mode="edit"
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
        </>
      )}
    </div>
  );
}
