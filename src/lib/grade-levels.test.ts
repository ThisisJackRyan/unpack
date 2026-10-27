import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GRADE_LEVELS, gradeLevelLabel, isGradeLevel } from "./grade-levels";

describe("gradeLevelLabel", () => {
  it("labels kindergarten, grades, and adult", () => {
    assert.equal(gradeLevelLabel("K"), "Kindergarten");
    assert.equal(gradeLevelLabel("1"), "Grade 1");
    assert.equal(gradeLevelLabel("12"), "Grade 12");
    assert.equal(gradeLevelLabel("adult"), "Adult");
  });

  it("labels every grade level", () => {
    for (const level of GRADE_LEVELS) {
      assert.ok(gradeLevelLabel(level).length > 0);
    }
  });
});

describe("isGradeLevel", () => {
  it("accepts only known levels", () => {
    assert.equal(isGradeLevel("K"), true);
    assert.equal(isGradeLevel("adult"), true);
    assert.equal(isGradeLevel("13"), false);
    assert.equal(isGradeLevel("k"), false);
    assert.equal(isGradeLevel(4), false);
    assert.equal(isGradeLevel(undefined), false);
  });
});
