import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { metaParts, metaSpokenText, studentOnReading } from "./meta-line";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("meta line", () => {
  it("keeps only present parts, so a missing one leaves no separator or comma", () => {
    assert.deepEqual(metaParts(["3 questions", null, undefined, false, "", "  ", "From example.com"]), [
      "3 questions",
      "From example.com",
    ]);
    assert.equal(metaSpokenText(["3 questions", null]), "3 questions.");
    assert.equal(metaSpokenText([null, "3 questions"]), "3 questions.");
    assert.equal(metaSpokenText([]), "");
  });

  // C4: short sentences, not a comma list ("3 questions, Same for
  // everyone" read as one run-on phrase).
  it("gives screen readers short sentences, with no dot separators or commas between parts", () => {
    assert.equal(metaSpokenText(["3 questions", "Same for everyone"]), "3 questions. Same for everyone.");
    assert.equal(metaSpokenText(["Grade 5", "3 questions", "From example.com"]), "Grade 5. 3 questions. From example.com.");
    assert.equal(metaSpokenText(["3 questions", "Written for Grade 5"]), "3 questions. Written for Grade 5.");
    assert.equal(metaSpokenText(["Oct 27", "Grade 5", "2 of 3 done"]), "Oct 27. Grade 5. 2 of 3 done.");
    for (const spoken of [metaSpokenText(["A", "B", "C"]), metaSpokenText(["3 questions", "Same for everyone"])]) {
      assert.doesNotMatch(spoken, /·|,|\.\.|^\.|\s\./);
    }
  });

  it("doesn't double the end mark", () => {
    assert.equal(metaSpokenText(["Done!", "Why?", "Ok."]), "Done! Why? Ok.");
  });

  it("speaks a student and a reading as one phrase", () => {
    assert.equal(studentOnReading("Qapr Sx", "QA PR16 Oct 27"), "Qapr Sx on QA PR16 Oct 27");
    assert.equal(studentOnReading(" Maya Ro ", " Foxes "), "Maya Ro on Foxes");
  });

  it("MetaLine speaks `spoken` when given, and the queue headings use it", () => {
    const component = read("../components/meta-line.tsx");
    assert.match(component, /<span className="sr-only">\{spoken \?\? metaSpokenText\(present\)\}<\/span>/);
    const queue = read("../app/teacher/classes/[id]/challenges/queue.tsx");
    const headings = queue.match(/<MetaLine as="span" parts=\{\[item\.studentName, item\.readingTitle\]\} spoken=\{studentOnReading\(item\.studentName, item\.readingTitle\)\} \/>/g);
    assert.equal(headings?.length, 2);
  });

  it("Let them try again names the student and reading as a phrase, not a comma list", () => {
    const reset = read("../app/teacher/classes/[id]/students/reset-tries.tsx");
    assert.match(reset, /<span className="sr-only">\s*\{" "\}\s*for \{name\} on \{readingTitle\}\s*<\/span>/);
    assert.doesNotMatch(reset, /\(\{name\}, \{readingTitle\}\)/);
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
  // article-title.ts only reads "·" in web page titles, never shows it.
  it("no hand-rolled separators are left in any page or component", () => {
    const root = new URL("../", import.meta.url);
    const files = (readdirSync(root, { recursive: true }) as string[]).filter(
      (f) =>
        /\.tsx?$/.test(f) &&
        !/\.test\.tsx?$/.test(f) &&
        !/meta-line\.tsx?$/.test(f) &&
        f !== "lib/article-title.ts",
    );
    assert.ok(files.length > 50, `scanned ${files.length} files`);
    for (const f of files) {
      const source = readFileSync(new URL(f, root), "utf8");
      assert.doesNotMatch(source, /[·•]|&middot;|&bull;|\\u00b7|\\u2022/i, f);
      assert.doesNotMatch(source, /sr-only">,\s*</, f);
    }
  });

  // C4: the class progress page linked each student's name twice (a table
  // for wide screens and cards for narrow ones, both in the page). One
  // table now, so each row has one name link.
  it("the class progress page has one name link per student row", () => {
    const page = read("../app/teacher/classes/[id]/students/page.tsx");
    assert.doesNotMatch(page, /ProgressCards|md:hidden|md:block/);
    // One in the table's row header, one in the list shown before any
    // reading is published (never both: the page picks one).
    assert.equal(page.match(/<StudentLink\b/g)?.length, 2);
    assert.match(page, /<th scope="row"[^>]*>\s*<StudentLink\b/);
    assert.match(page, /: status\.readings\.length === 0 \? \([\s\S]*<StudentList\b[\s\S]*\) : \(\s*<ProgressTable\b[^/]*\/>\s*\)/);
  });
});
