import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SOLO_GRADE_REQUIRED_MESSAGE, validateSoloReadingForm } from "./self-reading-form";

const BASE = {
  source: "text",
  url: "",
  title: "The fox",
  bodyText: "The fox ran. ".repeat(30),
  gradeLevel: "6",
  questionCount: "3",
};

describe("validateSoloReadingForm", () => {
  it("accepts text with a reading level", () => {
    const result = validateSoloReadingForm(BASE);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.gradeLevel, "6");
      assert.equal(result.data.questionCount, 3);
    }
  });

  it("requires a reading level (no class grade to fall back on)", () => {
    const result = validateSoloReadingForm({ ...BASE, gradeLevel: "" });
    assert.deepEqual(result.ok ? null : result.errors, { gradeLevel: SOLO_GRADE_REQUIRED_MESSAGE });
  });

  it("keeps the shared form's rules (bad level, short text, missing link)", () => {
    const bad = validateSoloReadingForm({ ...BASE, gradeLevel: "13", bodyText: "short" });
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.equal(bad.errors.gradeLevel, "Choose a grade level.");
      assert.match(bad.errors.bodyText ?? "", /too short/);
    }
    const link = validateSoloReadingForm({ ...BASE, source: "link", url: "" });
    assert.equal(!link.ok && link.errors.url, "Paste a link to the reading.");
  });

  it("never reports a question mode error (it isn't on this form)", () => {
    const result = validateSoloReadingForm({ ...BASE, gradeLevel: "" });
    assert.equal(!result.ok && result.errors.questionMode, undefined);
  });
});
