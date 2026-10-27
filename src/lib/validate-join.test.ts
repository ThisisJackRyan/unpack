import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLASS_NOT_FOUND_MESSAGE,
  FIRST_NAME_MAX_LENGTH,
  formatInitials,
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

  it("accepts letters from any alphabet, hyphens, and apostrophes", () => {
    for (const firstName of ["Zoë", "José", "Jean-Luc", "D’Andre", "O'Neil", "Søren", "明"]) {
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

  it("refuses digits, symbols, and names that start with punctuation", () => {
    for (const firstName of ["Maya2", "M@ya", "-Maya", "'", "Maya!", "<b>"]) {
      assert.deepEqual(errors({ firstName }), {
        firstName: "Use letters only. Spaces, hyphens, and apostrophes are OK.",
      }, firstName);
    }
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
