import type { Metadata } from "next";
import Link from "next/link";
import { atClassLimit, countClasses } from "@/lib/classes";
import { getOrCreateTeacher } from "@/lib/teacher";
import { backLink, card, secondaryButton } from "@/components/ui";
import { NewClassForm } from "./new-class-form";

export const metadata: Metadata = {
  title: "New class",
};

export default async function NewClassPage() {
  const teacher = await getOrCreateTeacher();
  const limitReached = atClassLimit(teacher, await countClasses(teacher.id));

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      {limitReached ? (
        <div
          className={`${card} flex flex-col items-center gap-3 px-6 py-12 text-center`}
        >
          <h1 className="text-2xl font-semibold text-ink-950">
            You’re at your class limit
          </h1>
          <p className="text-lg text-ink-700">
            The free plan includes 1 class.
          </p>
          <Link href="/teacher" className={`${secondaryButton} mt-3`}>
            Back to classes
          </Link>
        </div>
      ) : (
        <>
          <Link href="/teacher" className={`${backLink} self-start`}>
            <span aria-hidden="true">←</span> Back to classes
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight text-ink-950">
            New class
          </h1>
          <div className={`${card} p-6 sm:p-8`}>
            <NewClassForm />
          </div>
        </>
      )}
    </div>
  );
}
