import Link from "next/link";
import { SelfResultBadge } from "@/components/self-result-badge";
import { card, focusRing } from "@/components/ui";
import type { HistoryItem } from "@/lib/self-history";

// The self-learner's readings, newest first: title, date, level, and
// result. Each opens its reading page.
export function HistoryList({ items }: { items: HistoryItem[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            href={`/learn/r/${item.id}`}
            className={`${card} flex min-h-20 flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-2xl px-6 py-5 transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 ${focusRing}`}
          >
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-xl font-semibold break-words text-zinc-950">{item.title}</span>
              <span className="text-base text-zinc-600">
                <time dateTime={item.isoDate}>{item.dateLabel}</time>
                {item.gradeLabel && (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span className="sr-only">, </span>
                    {item.gradeLabel}
                  </>
                )}
              </span>
            </span>
            <SelfResultBadge result={item.result} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function EmptyHistory() {
  return (
    <div className={`${card} flex flex-col items-center gap-4 rounded-2xl px-6 py-14 text-center`}>
      <svg aria-hidden="true" viewBox="0 0 96 96" className="h-24 w-24" fill="none">
        <circle cx="48" cy="48" r="44" fill="#eef2ff" />
        <path d="M24 34c8-4 16-4 24 2v32c-8-6-16-6-24-2V34Z" fill="#fff" stroke="#4f46e5" strokeWidth="3" strokeLinejoin="round" />
        <path d="M72 34c-8-4-16-4-24 2v32c8-6 16-6 24-2V34Z" fill="#fff" stroke="#4f46e5" strokeWidth="3" strokeLinejoin="round" />
        <path d="M30 44c4-1 8-1 12 1M30 52c4-1 8-1 12 1M54 45c4-2 8-2 12-1M54 53c4-2 8-2 12-1" stroke="#a5b4fc" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <h2 className="text-2xl font-semibold text-zinc-950">No readings yet</h2>
      <p className="max-w-sm text-lg text-zinc-600">
        Paste a link or some text you want to read. We’ll ask you a few questions about it.
      </p>
      <StartLink className="mt-2" />
    </div>
  );
}

export function StartLink({ className = "" }: { className?: string }) {
  return (
    <Link
      href="/learn/new"
      className={`inline-flex min-h-14 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-7 text-lg font-semibold text-white transition-colors hover:bg-indigo-700 ${focusRing} ${className}`}
    >
      Start a new reading
    </Link>
  );
}
