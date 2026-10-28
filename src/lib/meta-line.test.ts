import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { metaParts, metaSpokenText } from "./meta-line";

describe("meta line", () => {
  it("keeps only present parts, so a missing one leaves no separator or comma", () => {
    assert.deepEqual(metaParts(["3 questions", null, undefined, false, "", "  ", "From example.com"]), [
      "3 questions",
      "From example.com",
    ]);
    assert.equal(metaSpokenText(["3 questions", null]), "3 questions");
    assert.equal(metaSpokenText([null, "3 questions"]), "3 questions");
    assert.equal(metaSpokenText([]), "");
  });

  it("gives screen readers one clean comma-separated sentence, with no dot separators", () => {
    const spoken = metaSpokenText(["Grade 5", "3 questions", "From example.com"]);
    assert.equal(spoken, "Grade 5, 3 questions, From example.com");
    assert.doesNotMatch(spoken, /·|, ,|^,|,\s*$/);
  });

  // The reading meta lines (student reader, self-learner reader, teacher
  // reading page) use MetaLine, not hand-made separators with sr-only
  // commas or a "·" read out as text.
  it("every reading meta line uses MetaLine", () => {
    for (const path of [
      "../app/c/r/[readingId]/page.tsx",
      "../app/learn/r/[readingId]/page.tsx",
      "../app/teacher/classes/[id]/readings/[readingId]/page.tsx",
      "../app/teacher/classes/[id]/readings/[readingId]/questions-panel.tsx",
      "../app/learn/history-list.tsx",
      "../app/c/page.tsx",
      "../app/teacher/classes/[id]/page.tsx",
      "../app/teacher/classes/[id]/challenges/queue.tsx",
    ]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      assert.match(source, /<MetaLine\b/, path);
      assert.doesNotMatch(source, /sr-only">, </, path);
      assert.doesNotMatch(source, /\} · /, path);
      assert.doesNotMatch(source, /> · </, path);
    }
  });

  // No list or meta line anywhere builds its own separator: no "·" or "•"
  // outside the shared helper, and no sr-only comma standing in for one.
  it("no hand-rolled separators are left in any page or component", () => {
    const root = new URL("../", import.meta.url);
    const files = (readdirSync(root, { recursive: true }) as string[]).filter(
      (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !/meta-line\.tsx?$/.test(f),
    );
    assert.ok(files.length > 50, `scanned ${files.length} files`);
    for (const f of files) {
      const source = readFileSync(new URL(f, root), "utf8");
      assert.doesNotMatch(source, /[·•]|&middot;|&bull;|\\u00b7|\\u2022/i, f);
      assert.doesNotMatch(source, /sr-only">,\s*</, f);
    }
  });
});
