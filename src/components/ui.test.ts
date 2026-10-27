import assert from "node:assert/strict";
import { test } from "node:test";
import { actionButton, dangerActionButton } from "./ui";

test("card action buttons: 48px targets, one shape, only Delete is red", () => {
  for (const cls of [actionButton, dangerActionButton]) {
    assert.match(cls, /\bmin-h-12\b/);
    assert.match(cls, /\brounded-xl\b/);
    assert.match(cls, /\bborder-2\b/);
    assert.match(cls, /focus-visible:outline-3/);
  }
  assert.ok(!actionButton.includes("danger"), actionButton);
  assert.match(dangerActionButton, /\bborder-danger-600\b/);
  assert.match(dangerActionButton, /\btext-danger-700\b/);
  assert.ok(!/\b(border|text)-ink-/.test(dangerActionButton), dangerActionButton);
});
