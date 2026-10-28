import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { atMaxLength, MAX_LENGTH_MESSAGE } from "./max-length";
import { ANSWER_MAX_LENGTH, CHALLENGE_NOTE_MAX_LENGTH } from "./validate-answers";
import { BODY_TEXT_MAX_LENGTH } from "./validate-reading";

describe("max length note", () => {
  it("shows only at the limit", () => {
    assert.equal(ANSWER_MAX_LENGTH, 1_000);
    assert.equal(atMaxLength(999, ANSWER_MAX_LENGTH), false);
    assert.equal(atMaxLength(1_000, ANSWER_MAX_LENGTH), true);
    assert.equal(atMaxLength(0, ANSWER_MAX_LENGTH), false);
    assert.equal(atMaxLength(CHALLENGE_NOTE_MAX_LENGTH, CHALLENGE_NOTE_MAX_LENGTH), true);
    // Over a soft limit is the reading form's own error, not this note.
    assert.equal(atMaxLength(BODY_TEXT_MAX_LENGTH + 1, BODY_TEXT_MAX_LENGTH), false);
  });

  it("is gentle copy with a curly apostrophe", () => {
    assert.equal(MAX_LENGTH_MESSAGE, "That\u2019s the max length");
    assert.ok(!MAX_LENGTH_MESSAGE.includes("'"));
    assert.ok(!MAX_LENGTH_MESSAGE.includes("\u2014"));
  });
});
