import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldAutoGenerate } from "./question-state";

const base = { flag: "1", status: "draft", mode: "shared", questionCount: 0 } as const;

test("Create & generate starts writing only for a shared draft with no questions", () => {
  assert.equal(shouldAutoGenerate(base), true);
  assert.equal(shouldAutoGenerate({ ...base, flag: undefined }), false);
  assert.equal(shouldAutoGenerate({ ...base, flag: "0" }), false);
  assert.equal(shouldAutoGenerate({ ...base, flag: ["1", "1"] }), false);
  assert.equal(shouldAutoGenerate({ ...base, status: "published" }), false);
  assert.equal(shouldAutoGenerate({ ...base, mode: "per_student" }), false);
  // A reload after the set was written must not write another.
  assert.equal(shouldAutoGenerate({ ...base, questionCount: 3 }), false);
});
