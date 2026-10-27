// Copy and paste blocking for the student reading view and answer boxes.
// The decisions are here, pure, so tests cover them; the React side is
// src/components/no-copy.tsx.
//
// This is a speed bump, not security. It stops the easy path (copy the
// text into a chatbot, paste an answer back), but a determined student can
// get around it: dev tools, turning off scripts, retyping, a photo of the
// screen, or another device. The effort check is the real gate.

// Events that are always cancelled, on the reading text and in answer
// boxes. contextmenu goes too, so a long press or right click offers no
// Copy, Paste, or Look Up menu.
// Mapped to the React prop that handles each one.
export const BLOCKED_EVENT_HANDLERS = {
  copy: "onCopy",
  cut: "onCut",
  paste: "onPaste",
  drop: "onDrop",
  dragstart: "onDragStart",
  contextmenu: "onContextMenu",
} as const;

export type BlockedHandlerName = (typeof BLOCKED_EVENT_HANDLERS)[keyof typeof BLOCKED_EVENT_HANDLERS];

// beforeinput types that bring text in from outside the keyboard, or take
// it out. insertFromYank is the Ctrl+Y "yank" on macOS; deleteByCut and
// deleteByDrag back up the cut and dragstart blocks. Typing, Backspace,
// autocorrect (insertReplacementText), and dictation are left alone.
const BLOCKED_INPUT_TYPES: ReadonlySet<string> = new Set([
  "insertFromPaste",
  "insertFromPasteAsQuotation",
  "insertFromDrop",
  "insertFromYank",
  "deleteByCut",
  "deleteByDrag",
]);

export function isBlockedInputType(inputType: string | null | undefined): boolean {
  return !!inputType && BLOCKED_INPUT_TYPES.has(inputType);
}

export type KeyLike = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

const SHORTCUT_KEYS: ReadonlySet<string> = new Set(["a", "c", "x", "v"]);

// Select all, copy, cut, and paste: Ctrl or Cmd with A, C, X, or V (with
// or without Shift, so Ctrl+Shift+V is caught too), plus the old Windows
// keys Ctrl+Insert (copy), Shift+Insert (paste), and Shift+Delete (cut).
// Ctrl+Alt is left alone: on many keyboards it is AltGr, which types
// letters.
export function isBlockedShortcut(e: KeyLike): boolean {
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && !e.altKey && SHORTCUT_KEYS.has(key)) return true;
  if (e.ctrlKey && !e.altKey && key === "insert") return true;
  if (e.shiftKey && !e.ctrlKey && !e.metaKey && (key === "insert" || key === "delete")) return true;
  return false;
}

export type SelectionLike = {
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionDirection?: string | null;
};

// Where to put the caret when an answer box has a range selected, or null
// to leave it (already a caret, or mid IME composition, where the browser
// may be using a range to show the word being composed). The caret goes to
// the end the student was moving, so Shift+arrows act like plain arrows,
// and typing and Backspace keep working.
export function collapsedCaret(selection: SelectionLike, composing = false): number | null {
  const { selectionStart: start, selectionEnd: end } = selection;
  if (composing || start === null || end === null || start === end) return null;
  return selection.selectionDirection === "backward" ? start : end;
}
