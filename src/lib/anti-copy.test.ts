import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  BLOCKED_EVENT_HANDLERS,
  isBlockedInputType,
  isBlockedShortcut,
  type KeyLike,
} from "./anti-copy";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("BLOCKED_EVENT_HANDLERS", () => {
  it("covers copy, cut, paste, drop, drag, and the context menu", () => {
    assert.deepEqual(BLOCKED_EVENT_HANDLERS, {
      copy: "onCopy",
      cut: "onCut",
      paste: "onPaste",
      drop: "onDrop",
      dragstart: "onDragStart",
      contextmenu: "onContextMenu",
    });
  });
});

describe("isBlockedInputType", () => {
  it("blocks paste, drop, yank, and cut input", () => {
    for (const t of ["insertFromPaste", "insertFromPasteAsQuotation", "insertFromDrop", "insertFromYank", "deleteByCut", "deleteByDrag"]) {
      assert.equal(isBlockedInputType(t), true, t);
    }
  });

  it("leaves typing, Backspace, autocorrect, and composition alone", () => {
    for (const t of [
      "insertText",
      "insertLineBreak",
      "insertParagraph",
      "deleteContentBackward",
      "deleteContentForward",
      "deleteWordBackward",
      "insertReplacementText",
      "insertCompositionText",
      "historyUndo",
      "",
      null,
      undefined,
    ]) {
      assert.equal(isBlockedInputType(t), false, String(t));
    }
  });
});

describe("isBlockedShortcut", () => {
  it("blocks copy, cut, and paste with Ctrl or Cmd, any case", () => {
    for (const k of ["c", "x", "v", "C", "X", "V"]) {
      assert.equal(isBlockedShortcut(key(k, { ctrlKey: true })), true, `ctrl+${k}`);
      assert.equal(isBlockedShortcut(key(k, { metaKey: true })), true, `cmd+${k}`);
    }
    assert.equal(isBlockedShortcut(key("V", { ctrlKey: true, shiftKey: true })), true, "ctrl+shift+v");
  });

  it("blocks the Insert and Delete clipboard keys", () => {
    assert.equal(isBlockedShortcut(key("Insert", { ctrlKey: true })), true);
    assert.equal(isBlockedShortcut(key("Insert", { shiftKey: true })), true);
    assert.equal(isBlockedShortcut(key("Delete", { shiftKey: true })), true);
  });

  it("leaves typing, Backspace, undo, arrows, and AltGr letters alone", () => {
    for (const k of [
      key("a"),
      key("A", { shiftKey: true }),
      key("v"),
      key("Backspace"),
      key("Backspace", { ctrlKey: true }),
      key("Delete"),
      key("z", { ctrlKey: true }),
      key("ArrowLeft", { shiftKey: true }),
      key("Enter"),
      key("c", { ctrlKey: true, altKey: true }),
      key("Insert"),
      // Select all: how a student clears an answer (F4).
      key("a", { ctrlKey: true }),
      key("A", { metaKey: true }),
    ]) {
      assert.equal(isBlockedShortcut(k), false, JSON.stringify(k));
    }
  });
});

// F4 (student QA): an answer box held "idk" from the last try; the
// student selected all, pressed Delete, typed a new answer and checked,
// and got "idk" glued to the new answer. Cause: the box blocked Ctrl+A
// and collapsed every range selection to a caret at its end, so Delete
// removed nothing and the new text went after "idk". A tiny model of the
// box, wired like NoCopyTextarea: keydown goes through isBlockedShortcut
// and beforeinput through isBlockedInputType; a selection is kept (the
// source check below makes sure nothing collapses it again).
type Box = { value: string; start: number; end: number };

function selectRange(box: Box, start: number, end: number): Box {
  return { ...box, start, end };
}

function press(box: Box, k: KeyLike): Box {
  if (isBlockedShortcut(k)) return box;
  if ((k.ctrlKey || k.metaKey) && k.key.toLowerCase() === "a") return selectRange(box, 0, box.value.length);
  return box;
}

function input(box: Box, inputType: string, data = ""): Box {
  if (isBlockedInputType(inputType)) return box;
  let { start, end } = box;
  if (start === end && inputType === "deleteContentForward") end = Math.min(box.value.length, end + 1);
  if (start === end && inputType === "deleteContentBackward") start = Math.max(0, start - 1);
  const value = box.value.slice(0, start) + data + box.value.slice(end);
  const caret = start + data.length;
  return { value, start: caret, end: caret };
}

function typeText(box: Box, text: string): Box {
  return [...text].reduce((b, ch) => input(b, "insertText", ch), box);
}

describe("clearing an answer box (F4)", () => {
  const idk: Box = { value: "idk", start: 3, end: 3 };

  it("select all with the keyboard, Delete, then a new answer replaces the old one", () => {
    let box = press(idk, key("a", { ctrlKey: true }));
    box = input(box, "deleteContentForward");
    box = typeText(box, "The fox hid.");
    assert.equal(box.value, "The fox hid.");
  });

  it("a mouse or long-press select all, Backspace, then a new answer replaces the old one", () => {
    let box = selectRange(idk, 0, 3);
    box = input(box, "deleteContentBackward");
    box = typeText(box, "The fox hid.");
    assert.equal(box.value, "The fox hid.");
  });

  it("selecting then typing over replaces the selection", () => {
    const box = typeText(selectRange(idk, 0, 3), "The fox hid.");
    assert.equal(box.value, "The fox hid.");
  });

  it("the answer box keeps a selection: nothing collapses it to a caret", () => {
    const source = readFileSync(new URL("../components/no-copy.tsx", import.meta.url), "utf8");
    const textarea = source.slice(source.indexOf("export function NoCopyTextarea"));
    assert.doesNotMatch(textarea, /setSelectionRange|selectionchange|"select"|"mouseup"/);
  });

  it("copy, cut, and paste stay blocked with text selected", () => {
    for (const k of ["c", "x", "v"]) assert.equal(isBlockedShortcut(key(k, { ctrlKey: true })), true, k);
    for (const t of ["insertFromPaste", "deleteByCut", "insertFromDrop"]) assert.equal(isBlockedInputType(t), true, t);
    assert.equal(input({ value: "idk", start: 0, end: 3 }, "deleteByCut").value, "idk");
  });
});
