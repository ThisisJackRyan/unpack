import { atMaxLength, MAX_LENGTH_MESSAGE } from "@/lib/max-length";

// Under a text box: amber (never red) and polite, with words only when the
// box is full. The region stays mounted (empty and hidden before), so a
// screen reader hears it the moment the limit is reached.
export function MaxLengthNote({ id, length, max, large = true }: { id: string; length: number; max: number; large?: boolean }) {
  return (
    <p
      id={id}
      role="status"
      aria-live="polite"
      className={`w-full font-medium text-warning-800 empty:hidden ${large ? "text-lg" : "text-base"}`}
    >
      {atMaxLength(length, max) ? MAX_LENGTH_MESSAGE : ""}
    </p>
  );
}
