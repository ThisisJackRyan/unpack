import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

// The .tsx files can't be rendered under plain Node (no JSX), so these
// check the source, like teacher-polish.test.ts.
const src = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, src), "utf8");

describe("the trimmed note on the teacher's edit form", () => {
  const page = read("app/teacher/classes/[id]/readings/[readingId]/edit/page.tsx");
  const form = read("components/reading-form.tsx");
  const textField = form.slice(form.indexOf('<label htmlFor="bodyText"'), form.indexOf('id="body-hint"'));

  test("the edit page passes the stored flag", () => {
    assert.match(page, /bodyTrimmed=\{reading\.bodyTrimmed\}/);
  });

  test("it shows only in edit mode, from the flag alone, not from what is typed", () => {
    assert.match(form, /const trimmedNote = mode === "edit" && bodyTrimmed;/);
  });

  test("it sits between the text label and the textarea, which points at it", () => {
    const note = textField.indexOf('{trimmedNote && <TrimmedNote id="body-trimmed" />}');
    assert.ok(note > 0, "note after the label");
    assert.ok(note < textField.indexOf("<textarea"), "note before the textarea");
    assert.match(textField, /aria-describedby=\{describedBy\(\s*trimmedNote && "body-trimmed",\s*"body-hint",\s*"body-count",/);
  });

  test("the note takes the id", () => {
    assert.match(read("components/trimmed-note.tsx"), /<p\s+id=\{id\}\s+role="note"/);
  });
});

describe("the trimmed note's text and where it shows", () => {
  test("it says what happened and what to do for a different part", () => {
    assert.match(
      read("components/trimmed-note.tsx"),
      /"This article was long, so we kept the first part\. To use a different part, paste that section as text instead\."/,
    );
  });

  test("the teacher's reading page and the self-learner's reading page show it, from the flag", () => {
    assert.match(read("app/teacher/classes/[id]/readings/[readingId]/page.tsx"), /\{reading\.bodyTrimmed && <TrimmedNote \/>\}/);
    assert.match(read("app/learn/r/[readingId]/page.tsx"), /\{reading\.bodyTrimmed && <TrimmedNote className="mb-6" \/>\}/);
  });

  test("class students never see it", () => {
    const page = read("app/c/r/[readingId]/page.tsx");
    assert.equal(page.includes("TrimmedNote"), false);
    assert.equal(page.includes("bodyTrimmed"), false);
    assert.equal(page.includes("TRIMMED_NOTE_MESSAGE"), false);
  });
});
