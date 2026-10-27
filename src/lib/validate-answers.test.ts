import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ANSWER_EMPTY_MESSAGE,
  ANSWER_FIELD_PREFIX,
  ANSWER_MAX_LENGTH,
  ANSWER_TOO_LONG_MESSAGE,
  answerEntries,
  CHALLENGE_NOTE_MAX_LENGTH,
  MAX_TRIES,
  NOTE_EMPTY_MESSAGE,
  NOTE_TOO_LONG_MESSAGE,
  sanitizeStudentText,
  validateAnswers,
  validateChallengeNote,
} from "./validate-answers";

const IDS = ["q1", "q2", "q3"];
const entries = (values: Record<string, unknown>) =>
  Object.entries(values).map(([questionId, value]) => ({ questionId, value }));

describe("limits", () => {
  it("are 3 tries, 1,000-character answers, and 500-character notes", () => {
    assert.equal(MAX_TRIES, 3);
    assert.equal(ANSWER_MAX_LENGTH, 1000);
    assert.equal(CHALLENGE_NOTE_MAX_LENGTH, 500);
  });
});

describe("sanitizeStudentText", () => {
  it("normalizes to NFC and trims", () => {
    assert.equal(sanitizeStudentText("  Zoé "), "Zoé");
  });

  it("keeps line breaks, drops other control and invisible characters", () => {
    assert.equal(sanitizeStudentText("a\r\nb\rc"), "a\nb\nc");
    assert.equal(sanitizeStudentText("a\u0000b\u0007c\u001bd\u007fe\u200bf\u202eg\ufeffh"), "abcdefgh");
    assert.equal(sanitizeStudentText("a\tb"), "a b");
    assert.equal(sanitizeStudentText("one  \n\n\n\ntwo"), "one\n\ntwo");
  });

  it("turns whitespace and control-only text into empty", () => {
    assert.equal(sanitizeStudentText(" \n\t\u0000\u200b "), "");
  });
});

describe("answerEntries", () => {
  it("keeps only answer fields, in order, duplicates included", () => {
    const form: [string, unknown][] = [
      [`${ANSWER_FIELD_PREFIX}q1`, "a"],
      ["$ACTION_ID_x", ""],
      [`${ANSWER_FIELD_PREFIX}q2`, "b"],
      [`${ANSWER_FIELD_PREFIX}q1`, "c"],
    ];
    assert.deepEqual(answerEntries(form), [
      { questionId: "q1", value: "a" },
      { questionId: "q2", value: "b" },
      { questionId: "q1", value: "c" },
    ]);
  });
});

describe("validateAnswers", () => {
  it("returns cleaned answers in question order", () => {
    const r = validateAnswers(IDS, entries({ q3: " C ", q1: "A\r\n", q2: "B" }));
    assert.deepEqual(r, {
      ok: true,
      answers: [
        { questionId: "q1", text: "A" },
        { questionId: "q2", text: "B" },
        { questionId: "q3", text: "C" },
      ],
    });
  });

  it("refuses a missing, extra, or doubled question as stale", () => {
    assert.deepEqual(validateAnswers(IDS, entries({ q1: "A", q2: "B" })), { ok: false, stale: true });
    assert.deepEqual(validateAnswers(IDS, entries({ q1: "A", q2: "B", q3: "C", q4: "D" })), { ok: false, stale: true });
    assert.deepEqual(validateAnswers(IDS, entries({ q1: "A", q2: "B", qX: "C" })), { ok: false, stale: true });
    assert.deepEqual(
      validateAnswers(IDS, [...entries({ q1: "A", q2: "B", q3: "C" }), { questionId: "q1", value: "again" }]),
      { ok: false, stale: true },
    );
    assert.deepEqual(validateAnswers(IDS, []), { ok: false, stale: true });
  });

  it("says which answers are blank or too long, with the student messages", () => {
    const r = validateAnswers(IDS, entries({ q1: "   ", q2: "x".repeat(ANSWER_MAX_LENGTH + 1), q3: "ok" }));
    assert.deepEqual(r, {
      ok: false,
      stale: false,
      errors: { q1: ANSWER_EMPTY_MESSAGE, q2: ANSWER_TOO_LONG_MESSAGE },
    });
    assert.equal(ANSWER_EMPTY_MESSAGE, "Write an answer here first.");
    assert.equal(ANSWER_TOO_LONG_MESSAGE, "This answer is too long. Make it shorter.");
  });

  it("accepts exactly the limit, counting after cleanup", () => {
    const max = "x".repeat(ANSWER_MAX_LENGTH);
    assert.equal(validateAnswers(["q1"], entries({ q1: max })).ok, true);
    assert.equal(validateAnswers(["q1"], entries({ q1: `  ${max}\u0000  ` })).ok, true);
    // A browser posts a line break as \r\n but counts it as 1.
    const twoLines = `a\r\n${"x".repeat(ANSWER_MAX_LENGTH - 2)}`;
    assert.equal(validateAnswers(["q1"], entries({ q1: twoLines })).ok, true);
    assert.equal(validateAnswers(["q1"], entries({ q1: `${twoLines}x` })).ok, false);
  });

  it("treats a non-string value (a file) as blank", () => {
    const r = validateAnswers(["q1"], entries({ q1: new Blob(["x"]) }));
    assert.deepEqual(r, { ok: false, stale: false, errors: { q1: ANSWER_EMPTY_MESSAGE } });
  });
});

describe("validateChallengeNote", () => {
  it("cleans and accepts 1 to 500 characters", () => {
    assert.deepEqual(validateChallengeNote("  I read it all.\u0000 "), { ok: true, note: "I read it all." });
    assert.equal(validateChallengeNote("x".repeat(CHALLENGE_NOTE_MAX_LENGTH)).ok, true);
  });

  it("refuses blank and too long notes with the student messages", () => {
    for (const blank of ["", "  \n ", null, undefined, 5]) {
      assert.deepEqual(validateChallengeNote(blank), { ok: false, error: NOTE_EMPTY_MESSAGE });
    }
    assert.deepEqual(validateChallengeNote("x".repeat(CHALLENGE_NOTE_MAX_LENGTH + 1)), {
      ok: false,
      error: NOTE_TOO_LONG_MESSAGE,
    });
  });
});
