import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLASS_NAME_MAX_LENGTH, validateCreateClass } from "./validate-class";

describe("validateCreateClass", () => {
  it("accepts a trimmed name and a known grade level", () => {
    const result = validateCreateClass({ name: "  Period 3  ", gradeLevel: "4" });
    assert.deepEqual(result, {
      ok: true,
      data: { name: "Period 3", gradeLevel: "4" },
      values: { name: "Period 3", gradeLevel: "4" },
    });
  });

  it("requires a name", () => {
    for (const name of ["", "   ", null, undefined]) {
      const result = validateCreateClass({ name, gradeLevel: "K" });
      assert.equal(result.ok, false);
      assert.deepEqual(!result.ok && result.errors, { name: "Enter a class name." });
    }
  });

  it("limits the name length", () => {
    const atLimit = "a".repeat(CLASS_NAME_MAX_LENGTH);
    assert.equal(validateCreateClass({ name: atLimit, gradeLevel: "K" }).ok, true);

    const result = validateCreateClass({ name: `${atLimit}a`, gradeLevel: "K" });
    assert.equal(result.ok, false);
    assert.deepEqual(!result.ok && result.errors, {
      name: `Keep the name to ${CLASS_NAME_MAX_LENGTH} characters or less.`,
    });
  });

  it("requires a known grade level", () => {
    for (const gradeLevel of ["", "13", "kindergarten", null]) {
      const result = validateCreateClass({ name: "Period 3", gradeLevel });
      assert.equal(result.ok, false);
      assert.deepEqual(!result.ok && result.errors, {
        gradeLevel: "Choose a grade level.",
      });
    }
  });

  it("reports both errors and echoes the input", () => {
    const result = validateCreateClass({ name: " ", gradeLevel: "x" });
    assert.deepEqual(result, {
      ok: false,
      errors: { name: "Enter a class name.", gradeLevel: "Choose a grade level." },
      values: { name: "", gradeLevel: "x" },
    });
  });
});
