import type { Metadata } from "next";
import Link from "next/link";
import { focusRing } from "@/components/ui";
import { requireSelfLearner } from "@/lib/account";
import { requestTimeZone } from "@/lib/request-time-zone";
import { currentAllowance, getAllowance, listSelfHistory } from "@/lib/self-readings";
import { AllowanceLeft, AllowanceLimit } from "./allowance";
import { EmptyHistory, HistoryList, StartLink } from "./history-list";

export const metadata: Metadata = {
  title: "Your reading",
};

const RECENT = 3;

// The self-learner's home: start a new reading (or the calm weekly limit),
// and the latest few readings with a link to all of them.
export default async function LearnHomePage() {
  const account = await requireSelfLearner();
  const { timeZone, fallback } = await requestTimeZone();
  const [state, history] = await Promise.all([getAllowance(account.id), listSelfHistory(account.id, timeZone)]);
  const allowance = currentAllowance();
  const now = new Date();

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-2">
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-950">Your reading</h1>
        <p className="text-lg text-zinc-600">Read something you like, then answer a few questions in your own words.</p>
      </div>

      {history.length === 0 ? (
        <EmptyHistory />
      ) : state.remaining > 0 ? (
        <div className="flex flex-col items-start gap-3">
          <StartLink />
          <AllowanceLeft state={state} allowance={allowance} />
        </div>
      ) : (
        <AllowanceLimit state={state} now={now} timeZone={timeZone} utcLabel={fallback} />
      )}

      {history.length > 0 && (
        <section aria-labelledby="recent-heading" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="recent-heading" className="text-2xl font-semibold tracking-tight text-zinc-950">
              Recent
            </h2>
            {history.length > RECENT && (
              <Link
                href="/learn/history"
                className={`inline-flex min-h-11 items-center rounded-lg px-2 text-base font-semibold text-indigo-700 underline-offset-2 hover:underline ${focusRing}`}
              >
                See all {history.length}
              </Link>
            )}
          </div>
          <HistoryList items={history.slice(0, RECENT)} />
        </section>
      )}
    </div>
  );
}
