import { STUDENT_READING_STATUS_LABELS, type StudentReadingStatus } from "@/lib/reading-progress";
import { pill } from "./ui";

// A student's status on a reading, in the ReadingStatusBadge style: a dot
// (a check when passed) and a text label, so it never relies on color.
// Used on the student's class home and the teacher's class view. Challenge
// denied is neutral (a ringed zinc pill with a hollow dot), never red: it
// is a decision, not an error.
const TONES: Record<StudentReadingStatus, { pill: string; dot: string }> = {
  not_started: { pill: "bg-ink-100 text-ink-700", dot: "bg-ink-400" },
  in_progress: { pill: "bg-primary-50 text-primary-700", dot: "bg-primary-600" },
  passed: { pill: "bg-success-50 text-success-800", dot: "" },
  challenged: { pill: "bg-warning-50 text-warning-900", dot: "bg-warning-500" },
  challenge_denied: { pill: "bg-white text-ink-800 ring-1 ring-ink-300 ring-inset", dot: "border-2 border-ink-500" },
};

export function StudentReadingStatusBadge({
  status,
  size = "base",
}: {
  status: StudentReadingStatus;
  // "sm" for the teacher's table.
  size?: "base" | "sm";
}) {
  const tone = TONES[status];
  return (
    <span className={`${pill} ${tone.pill} ${size === "sm" ? "text-sm" : "text-base"}`}>
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

// "Needs a reset": the student used every "Try again" for this reading's
// own questions without getting any (ClassStatusCell.needsReset). Shown
// instead of Not started on the teacher's views. Amber and ringed with a
// hollow dot, so it reads apart from Challenged (filled amber), and never
// red: it's a fix for the teacher, not an error.
export const NEEDS_RESET_LABEL = "Needs a reset";

export function NeedsResetBadge({ size = "base" }: { size?: "base" | "sm" }) {
  return (
    <span className={`${pill} bg-white text-warning-900 ring-1 ring-warning-300 ring-inset ${size === "sm" ? "text-sm" : "text-base"}`}>
      <span aria-hidden="true" className="h-2 w-2 rounded-full border-2 border-warning-500" />
      {NEEDS_RESET_LABEL}
    </span>
  );
}
