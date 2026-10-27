import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classSettingsSavedMessage, gradeChangeWarning, warnsOnGradeChange } from "./class-settings";
import { validateCreateClass } from "./validate-class";

describe("class settings", () => {
  it("validates like creating a class", () => {
    assert.deepEqual(validateCreateClass({ name: "  Room 12  ", gradeLevel: "6" }), {
      ok: true,
      data: { name: "Room 12", gradeLevel: "6" },
      values: { name: "Room 12", gradeLevel: "6" },
    });
    const bad = validateCreateClass({ name: "   ", gradeLevel: "13" });
    assert.equal(bad.ok, false);
    assert.deepEqual(!bad.ok && bad.errors, { name: "Enter a class name.", gradeLevel: "Choose a grade level." });
    assert.equal(validateCreateClass({ name: "x".repeat(61), gradeLevel: "6" }).ok, false);
  });

  it("warns only for a different grade with drafts to clear", () => {
    assert.equal(warnsOnGradeChange("4", "6", 2), true);
    assert.equal(warnsOnGradeChange("4", "4", 2), false);
    assert.equal(warnsOnGradeChange("4", "6", 0), false);
  });

  it("says exactly what is cleared and what is kept", () => {
    assert.equal(
      gradeChangeWarning(1, "6"),
      "Changing the grade clears the questions of 1 draft reading that use the class grade, so they can be written again for Grade 6. Published readings, and drafts with their own grade, keep their questions.",
    );
    assert.match(gradeChangeWarning(3, "K"), /3 draft readings .* for Kindergarten\./);
    assert.equal(classSettingsSavedMessage(0), "Saved.");
    assert.equal(classSettingsSavedMessage(2), "Saved. Cleared the questions of 2 draft readings.");
  });
});
