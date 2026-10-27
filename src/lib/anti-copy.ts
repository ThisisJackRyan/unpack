// Copy and paste blocking for the student reading view and answer boxes.
// The decisions are here, pure, so tests cover them; the React side is
// src/components/no-copy.tsx.
//
// This is a speed bump, not security. It stops the easy path (copy the
// text into a chatbot, paste an answer back), but a determined student can
// get around it: dev tools, turning off scripts, retyping, a photo of the
// screen, or another device. The effort check is the real gate.
//
// It has a cost for students who need help reading: no selection means
// select-to-read tools (Read&Write, the browser's read-selected-text) don't
// work on the reading, and no context menu means no right-click spellcheck
// in answer boxes. A teacher setting to turn it off may come later (see
// docs/v1-spec.md).

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

// Select all (Ctrl+A) is not here: in an answer box it is how a student
// clears an answer to start over, and the copy, cut, and drag blocks still
// keep the selected text in the box. Blocking it, and collapsing every
// selection to a caret, made select all + Delete remove nothing, so a new
// answer was typed after the old one ("idk" glued to it, F4).
const SHORTCUT_KEYS: ReadonlySet<string> = new Set(["c", "x", "v"]);

// Copy, cut, and paste: Ctrl or Cmd with C, X, or V (with or without
// Shift, so Ctrl+Shift+V is caught too), plus the old Windows keys
// Ctrl+Insert (copy), Shift+Insert (paste), and Shift+Delete (cut).
// Ctrl+Alt is left alone: on many keyboards it is AltGr, which types
// letters.
export function isBlockedShortcut(e: KeyLike): boolean {
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && !e.altKey && SHORTCUT_KEYS.has(key)) return true;
  if (e.ctrlKey && !e.altKey && key === "insert") return true;
  if (e.shiftKey && !e.ctrlKey && !e.metaKey && (key === "insert" || key === "delete")) return true;
  return false;
}
