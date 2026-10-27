import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BLOCKED_EVENT_HANDLERS,
  collapsedCaret,
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
  it("blocks select all, copy, cut, and paste with Ctrl or Cmd, any case", () => {
    for (const k of ["a", "c", "x", "v", "A", "C", "X", "V"]) {
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
    ]) {
      assert.equal(isBlockedShortcut(k), false, JSON.stringify(k));
    }
  });
});

describe("collapsedCaret", () => {
  it("collapses a forward selection to its end and a backward one to its start", () => {
    assert.equal(collapsedCaret({ selectionStart: 2, selectionEnd: 9, selectionDirection: "forward" }), 9);
    assert.equal(collapsedCaret({ selectionStart: 2, selectionEnd: 9, selectionDirection: "none" }), 9);
    assert.equal(collapsedCaret({ selectionStart: 2, selectionEnd: 9, selectionDirection: "backward" }), 2);
    assert.equal(collapsedCaret({ selectionStart: 0, selectionEnd: 40 }), 40);
  });

  it("leaves a caret, an unknown selection, and IME composition alone", () => {
    assert.equal(collapsedCaret({ selectionStart: 4, selectionEnd: 4 }), null);
    assert.equal(collapsedCaret({ selectionStart: null, selectionEnd: null }), null);
    assert.equal(collapsedCaret({ selectionStart: 2, selectionEnd: 5 }, true), null);
  });
});
