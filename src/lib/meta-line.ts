// A reading's meta line ("Grade 5 · 3 questions · From example.com"): the
// parts that are present, shown with dot separators that screen readers
// skip, and one clean sentence for screen readers ("Grade 5, 3 questions,
// From example.com"). A missing part leaves no separator and no stray
// comma. Pure, so tests cover it; src/components/meta-line.tsx renders it.

export type MetaPart = string | null | undefined | false;

export const META_SEPARATOR = " · ";

// The parts with text, trimmed, in order.
export function metaParts(parts: readonly MetaPart[]): string[] {
  return parts.flatMap((part) => (typeof part === "string" && part.trim() !== "" ? [part.trim()] : []));
}

// What a screen reader hears: the present parts joined with commas.
export function metaSpokenText(parts: readonly MetaPart[]): string {
  return metaParts(parts).join(", ");
}
