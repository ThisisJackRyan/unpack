import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReadingForm } from "@/components/reading-form";
import { qaRoutesEnabled } from "@/lib/qa-routes";
import { QUESTION_COUNT_DEFAULT } from "@/lib/validate-reading";
import { qaCreateAction } from "./actions";

// The real ReadingForm in solo mode (as /learn/new renders it) with a fake
// action, for scripts/browser-check-create-guard.ts. 404 unless
// UNPACK_QA_ROUTES=1 (src/lib/qa-routes.ts: never set it in Vercel).
// ?mode=deadline (default) makes the account lookup outlast
// ?precheck=<ms> (default 1000), ?mode=throw makes it throw, ?mode=ok
// creates and redirects; ?run=<id> marks the server log.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "QA create guard", robots: { index: false, follow: false } };

function param(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function QaCreateGuardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!qaRoutesEnabled()) notFound();
  const params = await searchParams;
  const mode = param(params.mode);
  const precheck = Number(param(params.precheck));
  const action = qaCreateAction.bind(null, {
    mode: mode === "throw" || mode === "ok" ? mode : "deadline",
    precheckMs: Number.isFinite(precheck) && precheck >= 0 ? Math.min(precheck, 30_000) : 1_000,
    run: (param(params.run) ?? "default").slice(0, 40),
  });
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
      <h1 data-qa="create-guard" className="text-4xl font-bold">QA new reading</h1>
      <ReadingForm
        mode="solo"
        action={action}
        cancelHref="/qa/create-guard"
        initialValues={{
          source: "link",
          url: "",
          title: "",
          bodyText: "",
          gradeLevel: "",
          questionCount: String(QUESTION_COUNT_DEFAULT),
          questionMode: "shared",
        }}
      />
    </main>
  );
}
