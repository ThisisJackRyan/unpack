import type { Metadata } from "next";
import Link from "next/link";
import { gradeLevelLabel } from "@/lib/grade-levels";
import { questionModeLabel } from "@/lib/question-modes";
import { sourceHost } from "@/lib/validate-reading";
import { ReadingStatusBadge } from "@/components/reading-status-badge";
import { backLink, card, focusRing, secondaryButton } from "@/components/ui";
import { loadReading } from "../../loaders";

type Props = { params: Promise<{ id: string; readingId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id, readingId } = await params;
  const { reading } = await loadReading(id, readingId);
  return { title: reading.title };
}

export default async function ReadingPage({ params }: Props) {
  const { id, readingId } = await params;
  const { reading, class: found } = await loadReading(id, readingId);
  const classHref = `/teacher/classes/${found.id}`;
  const host = sourceHost(reading.sourceUrl);
  const paragraphs = reading.bodyText.split(/\n{2,}/);

  return (
    <div className="flex flex-col gap-8">
      <Link href={classHref} className={`${backLink} self-start`}>
        <span aria-hidden="true">←</span>{" "}
        <span className="break-words">Back to {found.name}</span>
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <ReadingStatusBadge status={reading.status} />
          <h1 className="text-3xl font-semibold tracking-tight break-words text-zinc-950">
            {reading.title}
          </h1>
        </div>
        {reading.status === "draft" && (
          <Link href={`${classHref}/readings/${reading.id}/edit`} className={secondaryButton}>
            Edit
          </Link>
        )}
      </div>

      <dl className={`${card} grid gap-x-6 gap-y-4 p-5 sm:grid-cols-2 sm:p-6`}>
        <Detail term="Grade level">
          {reading.gradeLevel
            ? gradeLevelLabel(reading.gradeLevel)
            : `Class grade (${gradeLevelLabel(found.gradeLevel)})`}
        </Detail>
        <Detail term="Questions">{reading.questionCount}</Detail>
        <Detail term="Question mode">{questionModeLabel(reading.questionMode)}</Detail>
        <Detail term="Source">
          {host && reading.sourceUrl ? (
            <a
              href={reading.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`rounded font-medium break-all text-indigo-700 underline underline-offset-2 hover:text-indigo-900 ${focusRing}`}
            >
              {host}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            "Pasted text"
          )}
        </Detail>
      </dl>

      <section aria-labelledby="text-heading" className={`${card} px-6 py-8 sm:px-10 sm:py-10`}>
        <h2 id="text-heading" className="sr-only">
          Reading text
        </h2>
        <div className="mx-auto flex max-w-prose flex-col gap-5 text-lg leading-relaxed text-zinc-800">
          {paragraphs.map((p, i) => (
            <p key={i} className="whitespace-pre-line break-words">
              {p}
            </p>
          ))}
        </div>
      </section>
    </div>
  );
}

function Detail({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-sm font-medium text-zinc-500">{term}</dt>
      <dd className="text-base font-semibold text-zinc-950">{children}</dd>
    </div>
  );
}
