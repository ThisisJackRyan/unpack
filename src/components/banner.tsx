import { CheckIcon } from "./answer-parts";
import { StarBadge } from "./illustrations";

// The result banner on a reading page (student and self-learner): green
// with a check (and a star badge) when done, primary otherwise. Never red:
// nothing here is an error.
export function Banner({ tone, title, children }: { tone: "done" | "info"; title: string; children: React.ReactNode }) {
  const done = tone === "done";
  return (
    <div
      className={`flex items-center gap-4 rounded-3xl border-2 px-5 py-5 sm:px-6 ${
        done ? "border-success-200 bg-success-50 text-success-950" : "border-primary-200 bg-primary-50 text-primary-950"
      }`}
    >
      {done && (
        <span className="flex h-11 w-11 shrink-0 items-center justify-center self-start rounded-full bg-success-600 text-white">
          <CheckIcon className="h-6 w-6" />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-2xl font-bold">{title}</p>
        <p className="text-lg">{children}</p>
      </div>
      {done && <StarBadge className="hidden h-24 w-20 shrink-0 sm:block" />}
    </div>
  );
}
