import type { Metadata } from "next";
import Link from "next/link";
import { ReadingForm } from "@/components/reading-form";
import { backLink, card } from "@/components/ui";
import { requireSelfLearner } from "@/lib/account";
import { requestTimeZone } from "@/lib/request-time-zone";
import { currentAllowance, getAllowance } from "@/lib/self-readings";
import { QUESTION_COUNT_DEFAULT } from "@/lib/validate-reading";
import { AllowanceLeft, AllowanceLimit } from "../allowance";
import { createSelfReadingAction } from "./actions";

export const metadata: Metadata = {
  title: "New reading",
};

export default async function NewSelfReadingPage() {
  const account = await requireSelfLearner();
  const state = await getAllowance(account.id);
  const { timeZone, fallback } = await requestTimeZone();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Link href="/learn" className={`${backLink} self-start`}>
        <span aria-hidden="true">←</span> Back to your reading
      </Link>
      <div className="flex flex-col gap-2">
        <h1 className="text-4xl font-semibold tracking-tight text-ink-950">New reading</h1>
        {state.remaining > 0 && <AllowanceLeft state={state} allowance={currentAllowance()} />}
      </div>
      {state.remaining === 0 ? (
        <AllowanceLimit state={state} now={new Date()} timeZone={timeZone} utcLabel={fallback} />
      ) : (
        <div className={`${card} p-6 sm:p-8`}>
          <ReadingForm
            mode="solo"
            action={createSelfReadingAction}
            cancelHref="/learn"
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
        </div>
      )}
    </div>
  );
}
