export const TRIMMED_NOTE_MESSAGE = "This article was long, so we kept the first part.";

// Above the text of a linked article that was cut to the length limit
// (readings.body_trimmed). A heads-up, not an error: soft amber (never
// red), one line, not dismissible. role="note", so a screen reader reads
// it with the text instead of announcing it; the icon is decorative. The
// id lets a text box point at it (aria-describedby).
export function TrimmedNote({ id, className = "" }: { id?: string; className?: string }) {
  return (
    <p
      id={id}
      role="note"
      className={`flex w-fit items-start gap-2 rounded-xl border border-warning-200 bg-warning-50 px-3 py-2 text-base font-medium text-warning-950 ${className}`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="mt-0.5 h-5 w-5 shrink-0 text-warning-700"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>{TRIMMED_NOTE_MESSAGE}</span>
    </p>
  );
}
