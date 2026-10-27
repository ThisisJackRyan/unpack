import Link from "next/link";
import { MetaLine } from "@/components/meta-line";
import { SelfResultBadge } from "@/components/self-result-badge";
import { OpenBook } from "@/components/illustrations";
import { card, focusRing, primaryButtonLarge } from "@/components/ui";
import { EMPTY_STATE_COPY, type EmptyStateScreen, type HistoryItem } from "@/lib/self-history";

// The self-learner's readings, newest first: title, a meta line (date, level,
// and "2 of 3 done" while in progress; only the parts present), and
// result. Each opens its reading page.
export function HistoryList({ items }: { items: HistoryItem[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            href={`/learn/r/${item.id}`}
            className={`${card} flex min-h-20 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-6 py-5 transition-colors hover:border-primary-300 hover:bg-primary-50 ${focusRing}`}
          >
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-xl font-bold break-words text-ink-950">{item.title}</span>
              <MetaLine as="span" className="text-lg text-ink-700" parts={[item.dateLabel, item.gradeLabel, item.doneLabel]} />
            </span>
            <SelfResultBadge result={item.result} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

// No readings yet. `screen` picks the copy: /learn says how to start,
// /learn/history says what will be listed there.
export function EmptyHistory({ screen }: { screen: EmptyStateScreen }) {
  const copy = EMPTY_STATE_COPY[screen];
  return (
    <div className={`${card} flex flex-col items-center gap-4 px-6 py-14 text-center`}>
      <OpenBook className="h-28 w-36" />
      <h2 className="text-2xl font-bold text-ink-950">{copy.heading}</h2>
      <p className="max-w-sm text-lg text-ink-700">{copy.body}</p>
      <StartLink className="mt-2" label={copy.button} />
    </div>
  );
}

export function StartLink({ className = "", label = "Start a new reading" }: { className?: string; label?: string }) {
  return (
    <Link
      href="/learn/new"
      className={`${primaryButtonLarge} ${className}`}
    >
      {label}
    </Link>
  );
}
