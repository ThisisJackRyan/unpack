import { STUDENT_READING_STATUS_LABELS, type StudentReadingStatus } from "@/lib/reading-progress";
import { pill } from "./ui";

// A student's status on a reading, in the ReadingStatusBadge style: a dot
// (a check when passed) and a text label, so it never relies on color.
const TONES: Record<StudentReadingStatus, { pill: string; dot: string }> = {
  not_started: { pill: "bg-zinc-100 text-zinc-700", dot: "bg-zinc-400" },
  in_progress: { pill: "bg-indigo-50 text-indigo-700", dot: "bg-indigo-600" },
  passed: { pill: "bg-emerald-50 text-emerald-800", dot: "" },
  challenged: { pill: "bg-amber-50 text-amber-900", dot: "bg-amber-500" },
};

export function StudentReadingStatusBadge({ status }: { status: StudentReadingStatus }) {
  const tone = TONES[status];
  return (
    <span className={`${pill} ${tone.pill} text-base`}>
      {status === "passed" ? (
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
      {STUDENT_READING_STATUS_LABELS[status]}
    </span>
  );
}
