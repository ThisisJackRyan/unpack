import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  generateJoinCode,
  isJoinCodeConflict,
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
  normalizeJoinCode,
} from "./join-code";

describe("generateJoinCode", () => {
  it("returns 6 characters from the alphabet, with no look-alikes", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const code = generateJoinCode();
      assert.equal(code.length, JOIN_CODE_LENGTH);
      assert.equal(code.length, 6);
      for (const ch of code) {
        assert.ok(JOIN_CODE_ALPHABET.includes(ch), `unexpected ${ch} in ${code}`);
      }
      assert.doesNotMatch(code, /[0O1IL]/);
      seen.add(code);
    }
    // 5000 samples from 31^6 codes should be all or nearly all distinct.
    assert.ok(seen.size > 4990);
  });

  it("uses every alphabet character over many samples", () => {
    const chars = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      for (const ch of generateJoinCode()) chars.add(ch);
    }
    assert.equal(chars.size, JOIN_CODE_ALPHABET.length);
  });
});

describe("normalizeJoinCode", () => {
  it("uppercases and strips spaces and dashes", () => {
    assert.equal(normalizeJoinCode("abc-def"), "ABCDEF");
    assert.equal(normalizeJoinCode("  ab c\tdef "), "ABCDEF");
    assert.equal(normalizeJoinCode("AB--C D-EF"), "ABCDEF");
    assert.equal(normalizeJoinCode("ABCDEF"), "ABCDEF");
    assert.equal(normalizeJoinCode(""), "");
  });
});

describe("isJoinCodeConflict", () => {
  const conflict = { code: "23505", constraint: "classes_join_code_unique" };

  it("matches a 23505 on the join code constraint", () => {
    assert.equal(isJoinCodeConflict(conflict), true);
  });

  it("walks a nested cause chain", () => {
    const wrapped = new Error("outer", {
      cause: new Error("middle", { cause: conflict }),
    });
    assert.equal(isJoinCodeConflict(wrapped), true);
  });

  it("ignores a 23505 on another constraint", () => {
    assert.equal(
      isJoinCodeConflict({ code: "23505", constraint: "teachers_clerk_user_id_unique" }),
      false,
    );
    assert.equal(isJoinCodeConflict({ code: "23505" }), false);
  });

  it("ignores other error codes", () => {
    for (const code of ["40001", "23503", "22012", 23505]) {
      assert.equal(
        isJoinCodeConflict({ code, constraint: "classes_join_code_unique" }),
        false,
      );
    }
  });

  it("handles non-errors", () => {
    assert.equal(isJoinCodeConflict(undefined), false);
    assert.equal(isJoinCodeConflict(null), false);
    assert.equal(isJoinCodeConflict(new Error("boom")), false);
  });
});
