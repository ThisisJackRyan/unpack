import type { Metadata } from "next";
import { headers } from "next/headers";
import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getClassForTeacher } from "@/lib/classes";
import { gradeLevelLabel } from "@/lib/grade-levels";
import { getOrCreateTeacher } from "@/lib/teacher";
import { backLink, card } from "@/components/ui";
import { CopyButton } from "./copy-button";

type Props = { params: Promise<{ id: string }> };

// Cached so generateMetadata and the page share one query.
const loadClass = cache(async (id: string) => {
  const teacher = await getOrCreateTeacher();
  const found = await getClassForTeacher(id, teacher.id);
  if (!found) notFound();
  return found;
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const found = await loadClass(id);
  return { title: found.name };
}

export default async function ClassDetailPage({ params }: Props) {
  const { id } = await params;
  const found = await loadClass(id);
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

      <section
        aria-labelledby="join-code-heading"
        className={`${card} flex flex-col items-center gap-6 px-6 py-10 text-center sm:py-14`}
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
        <p className="pl-[0.2em] font-mono text-6xl font-bold tracking-[0.2em] text-zinc-950 sm:text-8xl">
          {found.joinCode}
        </p>
        <CopyButton value={found.joinCode} label="join code" />
        <p className="text-lg text-zinc-700">
          Students go to{" "}
          <span className="font-semibold text-zinc-950">{joinUrl}</span> and
          enter this code.
        </p>
      </section>
    </div>
  );
}
