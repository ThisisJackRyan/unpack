import type { AllowanceState, ReadingAllowance } from "@/lib/self-allowance";
import { allowanceLimitMessage, allowanceRemainingLabel, formatNextFree } from "@/lib/self-allowance";

// The weekly allowance, calm on purpose (amber, never red): being out of
// readings is not an error. The time is formatted here, on the server, in
// the reader's zone (see requestTimeZone), so hydration has nothing to
// disagree with.
export function AllowanceLimit({
  state,
  now,
  timeZone,
  utcLabel,
}: {
  state: AllowanceState;
  now: Date;
  timeZone: string;
  utcLabel: boolean;
}) {
  const when = state.nextFreeAt ? formatNextFree(state.nextFreeAt, now, timeZone, utcLabel) : "soon";
  return (
    <div role="status" className="flex gap-4 rounded-3xl border-2 border-warning-200 bg-warning-50 px-5 py-5 text-warning-950">
      <span aria-hidden="true" className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warning-100">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6 text-warning-700">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-xl font-bold">You’re all caught up for this week.</p>
        <p className="text-lg">{allowanceLimitMessage(state.used, when)}</p>
      </div>
    </div>
  );
}

export function AllowanceLeft({ state, allowance }: { state: AllowanceState; allowance: ReadingAllowance }) {
  return <p className="text-lg text-ink-600">{allowanceRemainingLabel(state, allowance)}</p>;
}
