import type { Metadata } from "next";
import { requireSelfLearner } from "@/lib/account";
import { requestTimeZone } from "@/lib/request-time-zone";
import { listSelfHistory } from "@/lib/self-readings";
import { EmptyHistory, HistoryList, StartLink } from "../history-list";

export const metadata: Metadata = {
  title: "History",
};

// Every reading the self-learner started, newest first, with its result.
// Scoped to the account in the query (see self-history.ts).
export default async function HistoryPage() {
  const account = await requireSelfLearner();
  const { timeZone } = await requestTimeZone();
  const items = await listSelfHistory(account.id, timeZone);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-950">History</h1>
        {items.length > 0 && <StartLink />}
      </div>
      {items.length === 0 ? <EmptyHistory /> : <HistoryList items={items} />}
    </div>
  );
}
