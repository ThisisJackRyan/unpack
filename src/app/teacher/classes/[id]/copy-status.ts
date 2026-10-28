// The copy button's words. "Copied!" is on the button for 2 seconds; the
// announcement says what was copied; the fallback asks to copy by hand
// (the code is selected for them).
export type CopyStatus = "idle" | "copied" | "failed";

export const COPY_STATUS_TEXT = {
  idleButton: "Copy",
  copiedButton: "Copied!",
  copiedAnnouncement: "Join code copied.",
  failed: "Couldn’t copy. The code is selected: press Ctrl+C (or ⌘+C) to copy it.",
} as const;
