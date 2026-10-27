import { SELF_RESULT_LABELS, type SelfReadingResult } from "@/lib/self-history";
import { pill } from "./ui";

// A self-learner's result on a reading, in the StudentReadingStatusBadge
// style: a dot (a check when passed) and a text label, so it never relies
// on color. Moved on is neutral, never red: it is a choice, not an error.
const TONES: Record<SelfReadingResult, { pill: string; dot: string }> = {
  in_progress: { pill: "bg-primary-50 text-primary-700", dot: "bg-primary-600" },
  passed: { pill: "bg-success-50 text-success-800", dot: "" },
  moved_on: { pill: "bg-white text-ink-800 ring-1 ring-ink-300 ring-inset", dot: "border-2 border-ink-500" },
};

export function SelfResultBadge({ result }: { result: SelfReadingResult }) {
  const tone = TONES[result];
  return (
    <span className={`${pill} ${tone.pill} text-base`}>
      {result === "passed" ? (
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
          <path
            fillRule="evenodd"
            d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z"
            clipRule="evenodd"
          />
        </svg>
      ) : (
        <span aria-hidden="true" className={`h-2 w-2 rounded-full ${tone.dot}`} />
      )}
      {SELF_RESULT_LABELS[result]}
    </span>
  );
}
