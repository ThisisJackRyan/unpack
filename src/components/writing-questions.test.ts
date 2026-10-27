import assert from "node:assert/strict";
import { test } from "node:test";
import * as text from "./writing-questions-text";

test("writing-questions lines end in a real ellipsis, no three dots, no em dash", () => {
  for (const line of Object.values(text)) {
    assert.ok(line.endsWith("…"), line);
    assert.ok(!line.includes("..."), line);
    assert.ok(!line.includes("—"), line);
  }
  assert.equal(text.WRITING_YOUR_QUESTIONS, "Writing your questions…");
});
