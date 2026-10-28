import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AnswerForm } from "@/components/answer-form";
import { qaRoutesEnabled } from "@/lib/qa-routes";
import type { StudentQuestion } from "@/lib/student-questions-core";
import { qaAnswerAction } from "./actions";

// The real answer form with a slow fake action, for
// scripts/browser-check-answer-timeout.ts. 404 unless UNPACK_QA_ROUTES=1.
// ?sleep=<ms> is how long the action takes, ?limit=<ms> how long the form
// waits, and ?redirect=1 makes the action redirect.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "QA answer timeout", robots: { index: false, follow: false } };

const questions: StudentQuestion[] = [
  { id: "qa-q1", position: 1, prompt: "QA question one" },
  { id: "qa-q2", position: 2, prompt: "QA question two" },
];

// Counts this server's renders of the page: a revalidatePath in the action
// re-renders it without a reload, and the number goes up.
let renders = 0;
function renderNumber(): number {
  renders += 1;
  return renders;
}

function msParam(value: string | string[] | undefined, fallback: number): number {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 30_000) : fallback;
}

export default async function QaAnswerTimeoutPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!qaRoutesEnabled()) notFound();
  const params = await searchParams;
  const sleepMs = msParam(params.sleep, 200);
  const limitMs = msParam(params.limit, 2_000);
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <p data-qa="render">{renderNumber()}</p>
      <AnswerForm
        action={qaAnswerAction.bind(null, sleepMs, params.redirect === "1")}
        questions={questions}
        tryNumber={1}
        maxTries={3}
        extraTry={false}
        previous={null}
        drafts={{ mode: "self", readingId: "qa-answer-timeout", ownerId: "qa" }}
        checkTimeoutMs={limitMs}
      />
    </main>
  );
}
