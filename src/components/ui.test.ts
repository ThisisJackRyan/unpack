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

// F7: badges, counters, and tips big enough to read.
test("badges and counters are at least 16px with roomy padding; student tips are 20px", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { pill } = await import("./ui");
  assert.match(pill, /\bpx-3\b/);
  assert.match(pill, /\bpy-1\b/);
  const root = new URL("../", import.meta.url);
  for (const f of readdirSync(root, { recursive: true }) as string[]) {
    if (!/\.tsx$/.test(f)) continue;
    assert.doesNotMatch(readFileSync(new URL(f, root), "utf8"), /\btext-(xs|sm)\b/, f);
  }
  const parts = readFileSync(new URL("./answer-parts.tsx", import.meta.url), "utf8");
  const nudge = parts.slice(parts.indexOf("export function Nudge"), parts.indexOf("export function QuestionNumber"));
  assert.match(nudge, /\btext-xl\b/);
  const badge = readFileSync(new URL("./student-reading-status-badge.tsx", import.meta.url), "utf8");
  assert.match(badge, /size === "sm" \? "text-base" : "text-lg"/);
});
