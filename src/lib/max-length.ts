// The gentle note under a text box once it's full: amber, never red (a
// full box is not a mistake), and only at the limit. Pure, so tests cover
// it; src/components/max-length-note.tsx renders it.

export const MAX_LENGTH_MESSAGE = "That’s the max length";

// `length` counts what the box's maxLength counts (UTF-16 code units).
// Over the limit (a box without a hard maxLength) is the form's own error,
// not this note.
export function atMaxLength(length: number, max: number): boolean {
  return length === max;
}
