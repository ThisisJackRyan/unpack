import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ClassAnswerForm, SelfAnswerForm } from "@/components/reading-answer-form";
import { qaRoutesEnabled } from "@/lib/qa-routes";
import type { StudentQuestion } from "@/lib/student-questions-core";
import { MAX_TRIES } from "@/lib/validate-answers";
import { qaAnswerAction } from "./actions";
import { qaLastTry } from "./tries";

// The real answer form with a slow fake action, for
// scripts/browser-check-answer-timeout.ts. 404 unless UNPACK_QA_ROUTES=1
// (src/lib/qa-routes.ts: never set it in Vercel).
// ?as=class (default) renders the form as /c/r/[readingId] does, ?as=self
// as /learn/r/[readingId] does (src/components/reading-answer-form.tsx).
// ?sleep=<ms> is how long the action takes, ?limit=<ms> how long the form
// waits, ?redirect=1 makes the action redirect, ?advance=1 makes it save a
// try (the page moves to the next one), ?stale=1 refuses a submit once the
// run has a saved try (as out of date), ?precheck=<ms> bounds the wait as
// a lookup before the claim, and ?run=<id> keeps one case's tries apart.
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

function param(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function msParam(value: string | string[] | undefined, fallback: number): number {
  const n = Number(param(value));
  return value !== undefined && Number.isFinite(n) && n >= 0 ? Math.min(n, 30_000) : fallback;
}

export default async function QaAnswerTimeoutPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!qaRoutesEnabled()) notFound();
  const params = await searchParams;
  const run = (param(params.run) ?? "default").slice(0, 40);
  const action = qaAnswerAction.bind(null, {
    sleepMs: msParam(params.sleep, 200),
    redirect: param(params.redirect) === "1",
    advance: param(params.advance) === "1",
    stale: param(params.stale) === "1",
    run,
    precheckMs: params.precheck === undefined ? null : msParam(params.precheck, 0),
  });
  const previous = qaLastTry(run);
  const tryNumber = Math.min(1 + (previous?.tryNumber ?? 0), MAX_TRIES);
  const stage = { kind: "answer" as const, tryNumber, maxTries: MAX_TRIES, previous, extraTry: false };
  const Form = param(params.as) === "self" ? SelfAnswerForm : ClassAnswerForm;
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <p data-qa="render">{renderNumber()}</p>
      <Form
        action={action}
        readingId="qa-answer-timeout"
        ownerId={`qa-${run}`}
        questions={questions}
        stage={stage}
        checkTimeoutMs={msParam(params.limit, 2_000)}
      />
    </main>
  );
}
