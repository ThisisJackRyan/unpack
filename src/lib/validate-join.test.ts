import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLASS_NOT_FOUND_MESSAGE,
  FIRST_NAME_INVALID_MESSAGE,
  FIRST_NAME_MAX_LENGTH,
  formatInitials,
  JOIN_BLOCKED_CONFIG_TAG,
  JOIN_DISABLED_MESSAGE,
  JOIN_FAILED_MESSAGE,
  logJoinBlockedConfig,
  validateJoin,
} from "./validate-join";

const ok = { code: "abc 234", firstName: "Maya", lastInitials: "ro" };

function errors(input: Partial<typeof ok>) {
  const result = validateJoin({ ...ok, ...input });
  assert.equal(result.ok, false);
  return !result.ok && result.errors;
}

describe("validateJoin", () => {
  it("normalizes the code, trims the name, and formats the initials", () => {
    const result = validateJoin({ code: " abc-234 ", firstName: "  Mary   Ann ", lastInitials: " rO " });
    assert.deepEqual(result, {
      ok: true,
      data: { code: "ABC234", firstName: "Mary Ann", lastInitials: "Ro" },
      values: { code: "ABC234", firstName: "Mary Ann", lastInitials: "Ro" },
    });
  });

  it("accepts letters from any alphabet, hyphens, apostrophes, and ʻokina", () => {
    for (const firstName of [
      "ʻIolani",
      "Keʻalaʻula",
      "ʻAkoni",
      "'Iolani",
      "‘Iolani",
      "Mary-Kate O’Neil",
      "Zoë",
      "José",
      "Jean-Luc",
      "D’Andre",
      "D‘Andre",
      "DʼAndre",
      "Keʻala",
      "O'Neil",
      "Søren",
      "明",
      "A",
      "Zoe\u0301",
      "Mary Ann",
    ]) {
      assert.equal(validateJoin({ ...ok, firstName }).ok, true, firstName);
    }
    assert.equal(validateJoin({ ...ok, lastInitials: "Ø" }).ok, true);
  });

  it("requires every field", () => {
    for (const blank of ["", "   ", null, undefined, 42]) {
      assert.deepEqual(errors({ code: blank as string }), { code: "Enter your class code." });
      assert.deepEqual(errors({ firstName: blank as string }), { firstName: "Enter your first name." });
      assert.deepEqual(errors({ lastInitials: blank as string }), {
        lastInitials: "Enter the first 1 or 2 letters of your last name.",
      });
    }
  });

  it("limits the first name length, counting characters people see", () => {
    assert.equal(validateJoin({ ...ok, firstName: "a".repeat(FIRST_NAME_MAX_LENGTH) }).ok, true);
    assert.equal(validateJoin({ ...ok, firstName: "é".repeat(FIRST_NAME_MAX_LENGTH) }).ok, true);
    assert.deepEqual(errors({ firstName: "a".repeat(FIRST_NAME_MAX_LENGTH + 1) }), {
      firstName: "Keep your first name to 30 letters or less.",
    });
  });

  it("refuses digits, symbols, a leading hyphen, a trailing mark, and marks alone", () => {
    for (const firstName of [
      "Maya2",
      "M@ya",
      "-Maya",
      "'",
      "Maya!",
      "<b>",
      "\u0301",
      "Mia-",
      "Mia'",
      "Mia’",
      "Mia `Ann",
      "Miaʼ",
      "Miaʻ",
      "ʼ",
      "ʻ",
      "ʻʻ",
      "-",
      "Mia ʼ",
      "ʻʻIolani",
      "'-Mia",
      "ʻ Iolani",
      "`Mia",
    ]) {
      assert.deepEqual(errors({ firstName }), { firstName: FIRST_NAME_INVALID_MESSAGE }, firstName);
    }
    assert.equal(FIRST_NAME_INVALID_MESSAGE, "Use letters only. Spaces, hyphens, apostrophes, and ʻokina are OK.");
  });

  it("takes 1 or 2 letters of the last name, nothing more", () => {
    assert.equal(validateJoin({ ...ok, lastInitials: "R" }).ok, true);
    for (const lastInitials of ["Rod", "R1", "R.", "-"]) {
      assert.deepEqual(errors({ lastInitials }), {
        lastInitials: "Use just 1 or 2 letters of your last name.",
      }, lastInitials);
    }
  });

  it("refuses a code that can't be real without a lookup", () => {
    assert.deepEqual(errors({ code: "ABC$23" }), { code: CLASS_NOT_FOUND_MESSAGE });
    assert.deepEqual(errors({ code: "A".repeat(13) }), { code: CLASS_NOT_FOUND_MESSAGE });
    assert.equal(CLASS_NOT_FOUND_MESSAGE, "We couldn’t find that class code. Check it with your teacher.");
  });

  // Every refused code gets the code-field "couldn't find" text, never the
  // generic failure; only an empty one (after spaces and dashes go) asks
  // for a code.
  it("refuses every malformed code with the code-field not-found message", () => {
    const malformed = [
      "ABC 23$", // a symbol
      "ABC_234", // an underscore
      "ABC.234", // a dot
      "ABC–234", // an en dash, which isn't stripped
      "ABC\u200B234", // a zero-width space, which isn't stripped
      "ÀBC234", // an accented letter
      "АВС234", // Cyrillic look-alikes
      "ABC２３４", // full-width digits
      "ABC\u0000234", // a NUL, which Postgres text can't hold
      "'; drop table classes; --", // SQL-looking junk
      "A".repeat(13), // too long
      "ab-cd-ef-gh-jk-mn-p", // too long once normalized (13)
      "ß".repeat(7), // uppercases to 14 letters
    ];
    for (const code of malformed) {
      assert.deepEqual(errors({ code }), { code: CLASS_NOT_FOUND_MESSAGE }, code);
    }
    for (const code of ["-", " - - ", "\t"]) {
      assert.deepEqual(errors({ code }), { code: "Enter your class code." }, code);
    }
  });

  it("lets through, for a lookup, codes that only normalize or that no class can have", () => {
    const cases: [string, string][] = [
      ["abc234", "ABC234"], // lowercase
      ["ABC 234", "ABC234"], // a space
      ["abc-234", "ABC234"], // a dash
      [" a-b c\u00A02 3-4 ", "ABC234"], // mixed, with a no-break space
      ["ZZZZZZ", "ZZZZZZ"], // well formed, matches no class
      ["O0I1L0", "O0I1L0"], // outside the code alphabet: the lookup misses
      ["A", "A"], // too short: the lookup misses
      ["ABCDEFGHJKMN", "ABCDEFGHJKMN"], // 12, the longest let through
    ];
    for (const [code, normalized] of cases) {
      const result = validateJoin({ ...ok, code });
      assert.ok(result.ok, code);
      assert.equal(result.data.code, normalized, code);
    }
  });

  it("echoes the cleaned values after an error", () => {
    const result = validateJoin({ code: "abc", firstName: " Maya ", lastInitials: "" });
    assert.deepEqual(result.values, { code: "ABC", firstName: "Maya", lastInitials: "" });
  });
});

describe("formatInitials", () => {
  it("capitalizes the first letter only", () => {
    assert.equal(formatInitials("ro"), "Ro");
    assert.equal(formatInitials("RO"), "Ro");
    assert.equal(formatInitials("r"), "R");
  });
});

describe("join blocked by server setup", () => {
  it("has its own message, distinct from the generic failure", () => {
    assert.equal(JOIN_DISABLED_MESSAGE, "Joining isn\u2019t working right now. Please try again in a little while.");
    assert.notEqual(JOIN_DISABLED_MESSAGE, JOIN_FAILED_MESSAGE);
    assert.doesNotMatch(JOIN_DISABLED_MESSAGE, /'|\u2014/);
  });

  it("logs one tagged line with the names and the message only", () => {
    const calls: unknown[][] = [];
    logJoinBlockedConfig({ missing: ["JOIN_IP_HASH_SECRET"], message: "why" }, (...args) => calls.push(args));
    assert.deepEqual(calls, [[JOIN_BLOCKED_CONFIG_TAG, { missing: ["JOIN_IP_HASH_SECRET"], message: "why" }]]);
    assert.equal(JOIN_BLOCKED_CONFIG_TAG, "join_blocked_config");
  });
});
