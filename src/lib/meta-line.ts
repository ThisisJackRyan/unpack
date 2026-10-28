// A reading's meta line ("Grade 5 · 3 questions · From example.com"): the
// parts that are present, shown with dot separators that screen readers
// skip, and short sentences for screen readers ("Grade 5. 3 questions.
// From example.com."), so each part reads as its own phrase instead of a
// comma list. A missing part leaves no separator and no stray period.
// Pure, so tests cover it; src/components/meta-line.tsx renders it.

export type MetaPart = string | null | undefined | false;

export const META_SEPARATOR = " · ";

// The parts with text, trimmed, in order.
export function metaParts(parts: readonly MetaPart[]): string[] {
  return parts.flatMap((part) => (typeof part === "string" && part.trim() !== "" ? [part.trim()] : []));
}

// What a screen reader hears: each present part as a sentence.
export function metaSpokenText(parts: readonly MetaPart[]): string {
  return metaParts(parts)
    .map((part) => (/[.!?]$/.test(part) ? part : `${part}.`))
    .join(" ");
}

// A line about one student on one reading (the challenge queue's card
// headings), spoken as a phrase: "Maya Ro on Foxes".
export function studentOnReading(student: string, reading: string): string {
  return `${student.trim()} on ${reading.trim()}`;
}
