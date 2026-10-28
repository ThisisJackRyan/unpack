import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Statement } from "./link-rate-limit";
import {
  checkPublish,
  deleteQuestionStatements,
  editApplied,
  editReadingStatements,
  LAST_QUESTION_MESSAGE,
  lockDraftStatement,
  planDelete,
  PUBLISH_NEEDS_QUESTIONS_MESSAGE,
  publishStatements,
  PUBLISHED_TITLE_ONLY_MESSAGE,
  READING_CHANGED_MESSAGE,
  updateQuestionStatements,
  writeSetStatements,
  type ReadingRef,
} from "./shared-questions";
import {
  deleteSharedQuestion,
  publishReading,
  saveQuestionSet,
  updateSharedQuestion,
} from "./shared-questions-db";
import { saveReadingEdit } from "./readings";

const REF: ReadingRef = {
  readingId: "00000000-0000-4000-8000-00000000000a",
  classId: "00000000-0000-4000-8000-00000000000c",
  teacherId: "00000000-0000-4000-8000-00000000000t",
};
const Q = "00000000-0000-4000-8000-0000000000q1";
const FP = { bodyMd5: "abc", gradeLevel: "4" as const, questionCount: 3 };
const PROMPTS = ["A?", "B?", "C?"];

const ALL_WRITES: [string, Statement[]][] = [
  ["generate", writeSetStatements(REF, FP, PROMPTS, "generate")],
  ["replace", writeSetStatements(REF, FP, PROMPTS, "replace")],
  ["update", updateQuestionStatements(REF, Q, "New?")],
  ["delete", deleteQuestionStatements(REF, Q)],
  ["publish", publishStatements(REF)],
  ["edit", editReadingStatements(REF, { title: "T", bodyText: "x", gradeLevel: null, questionCount: 3, questionMode: "shared" })],
];

// What Postgres returns once the reading is published: the lock matches no
// row and every draft-guarded statement changes nothing.
const publishedExecutor = async (statements: Statement[]) => statements.map(() => []);

describe("publish lock", () => {
  it("every write starts by locking the reading while it's an owned draft", () => {
    const lock = lockDraftStatement(REF);
    assert.match(lock.text, /r\.status = 'draft'/);
    assert.match(lock.text, /c\.teacher_id = \$3::uuid/);
    assert.match(lock.text, /for update of r$/);
    for (const [name, statements] of ALL_WRITES) {
      assert.deepEqual(statements[0], lock, name);
    }
  });

  it("every later write is guarded by the draft check (or only touches its own temp rows)", () => {
    for (const [name, statements] of ALL_WRITES) {
      // The edit's published title update is checked in editReadingStatements.
      const guarded = name === "edit" ? statements.slice(1, 3) : statements.slice(1);
      for (const s of guarded) {
        const tempOnly = /position < 0/.test(s.text) && !/position > 0/.test(s.text);
        assert.ok(tempOnly || /status = 'draft'/.test(s.text), `${name}: ${s.text}`);
      }
    }
  });

  it("never puts ids or text in the SQL", () => {
    for (const [, statements] of ALL_WRITES) {
      for (const s of statements) {
        for (const value of [REF.readingId, REF.teacherId, Q, "New?", "A?"]) {
          assert.equal(s.text.includes(value), false);
        }
      }
    }
  });

  it("refuses every mutation on a published reading", async () => {
    assert.equal(await saveQuestionSet(REF, FP, PROMPTS, "generate", publishedExecutor), false);
    assert.equal(await saveQuestionSet(REF, FP, PROMPTS, "replace", publishedExecutor), false);
    assert.equal(await updateSharedQuestion(REF, Q, "New?", publishedExecutor), false);
    assert.equal(await deleteSharedQuestion(REF, Q, publishedExecutor), false);
    assert.equal(await publishReading(REF, publishedExecutor), false);
  });

  it("applies when the guarded statement returns rows", async () => {
    const ok = (rows: number) => async (statements: Statement[]) =>
      statements.map((_, i) =>
        i === statements.length - 1 ? Array.from({ length: rows }, (_, n) => ({ id: n })) : [{ id: 1 }],
      );
    assert.equal(await saveQuestionSet(REF, FP, PROMPTS, "generate", ok(3)), true);
    assert.equal(await saveQuestionSet(REF, FP, PROMPTS, "generate", ok(2)), false);
    assert.equal(await updateSharedQuestion(REF, Q, "New?", ok(1)), true);
    assert.equal(await publishReading(REF, ok(1)), true);
    assert.equal(
      await deleteSharedQuestion(REF, Q, async () => [[{ id: 1 }], [{ question_count: 2 }], [], []]),
      true,
    );
  });
});

describe("writeSetStatements", () => {
  it("generate only inserts into an empty set", () => {
    const s = writeSetStatements(REF, FP, PROMPTS, "generate");
    assert.equal(s.length, 2);
    assert.match(s[1].text, /^insert into questions/);
    assert.match(s[1].text, /not exists \(\s*select 1 from questions where reading_id = \$1::uuid and student_id is null/);
  });

  it("replace deletes then inserts, in one batch", () => {
    const s = writeSetStatements(REF, FP, PROMPTS, "replace");
    assert.equal(s.length, 3);
    assert.match(s[1].text, /^delete from questions/);
    assert.match(s[2].text, /^insert into questions/);
  });

  it("only saves if the reading still matches what was written from", () => {
    const [, insert] = writeSetStatements(REF, FP, PROMPTS, "generate");
    assert.match(insert.text, /r\.question_count = \$4::int/);
    assert.match(insert.text, /md5\(r\.body_text\) = \$5::text/);
    assert.match(insert.text, /coalesce\(r\.grade_level, c\.grade_level\) = \$6::grade_level/);
    assert.match(insert.text, /\$9::int = \$4::int/);
    assert.deepEqual(insert.params.slice(3), [3, "abc", "4", [1, 2, 3], PROMPTS, 3]);
  });
});

describe("deleteQuestionStatements", () => {
  const [, del, negate, renumber] = deleteQuestionStatements(REF, Q);

  it("lowers question_count in the same statement, never below 1", () => {
    assert.match(del.text, /delete from questions/);
    assert.match(del.text, /select question_count from readings where id = \$1::uuid\) > 1/);
    assert.match(del.text, /update readings set question_count = question_count - 1/);
    assert.match(del.text, /exists \(select 1 from deleted\)/);
  });

  it("renumbers through negative positions, in original order", () => {
    assert.match(negate.text, /set position = -position/);
    assert.match(renumber.text, /row_number\(\) over \(order by position desc\)/);
    assert.match(renumber.text, /position < 0/);
  });
});

describe("editReadingStatements", () => {
  const EDIT = {
    title: "T",
    bodyText: "body",
    gradeLevel: "5" as const,
    questionCount: 4,
    questionMode: "shared" as const,
  };
  const [, clear, update, titleOnly] = editReadingStatements(REF, {
    title: "T",
    bodyText: "body",
    gradeLevel: "5",
    questionCount: 4,
    questionMode: "shared",
  });

  it("clears the shared set first, only if text, grade, count, or mode changed", () => {
    assert.match(clear.text, /^delete from questions/);
    assert.match(clear.text, /student_id is null/);
    for (const col of ["body_text", "grade_level", "question_count", "question_mode"]) {
      assert.match(clear.text, new RegExp(`r\\.${col} (is distinct from|<>)`));
    }
    assert.equal(/title/.test(clear.text), false);
  });

  it("then updates the draft only", () => {
    assert.match(update.text, /^update readings r set/);
    assert.match(update.text, /r\.status = 'draft'/);
    assert.match(update.text, /returning r\.id$/);
    assert.deepEqual(update.params.slice(3), ["body", "5", 4, "shared", "T"]);
  });

  it("keeps a trimmed article's flag only while its text is unchanged (edited text is the teacher's)", () => {
    // In an UPDATE's SET, r.body_text is the row's text before the update.
    assert.match(update.text, /\n  body_trimmed = r\.body_trimmed and r\.body_text = \$4::text,\n/);
    assert.equal(/body_trimmed/.test(titleOnly.text), false);
  });

  it("on a published reading changes only the title, and only if nothing else changed", () => {
    assert.match(titleOnly.text, /^update readings r set title = \$8::text\nfrom classes c/);
    assert.equal(/body_text =\s*\$4::text,|question_count = \$6::int,/.test(titleOnly.text), false);
    assert.match(titleOnly.text, /r\.status = 'published'/);
    assert.match(titleOnly.text, /r\.body_text = \$4::text/);
    assert.match(titleOnly.text, /r\.grade_level is not distinct from \$5::grade_level/);
    assert.match(titleOnly.text, /r\.question_count = \$6::int/);
    assert.match(titleOnly.text, /r\.question_mode = \$7::question_mode/);
    assert.match(titleOnly.text, /c\.teacher_id = \$3::uuid/);
    assert.equal(/questions/.test(titleOnly.text), false);
    assert.deepEqual(titleOnly.params, update.params);
  });

  it("applies when the draft update or the title update returns a row", () => {
    assert.equal(editApplied([[{ id: 1 }], [], [{ id: 1 }], []]), true);
    assert.equal(editApplied([[], [], [], [{ id: 1 }]]), true);
    assert.equal(editApplied([[], [], [], []]), false);
  });

  // What Postgres does with the batch for a published reading: the lock
  // and the draft writes match nothing; the title update matches only if
  // every other field is what's saved.
  const SAVED = { ...EDIT, title: "Old" };
  function publishedReading() {
    let title = SAVED.title;
    const execute = async (statements: Statement[]) => {
      const [, , , t] = statements;
      const [, , , body, grade, count, mode, newTitle] = t.params;
      const same =
        body === SAVED.bodyText && grade === SAVED.gradeLevel &&
        count === SAVED.questionCount && mode === SAVED.questionMode;
      if (same) title = String(newTitle);
      return [[], [], [], same ? [{ id: REF.readingId }] : []];
    };
    return { execute, title: () => title };
  }

  it("saves a title-only edit to a published reading", async () => {
    const db = publishedReading();
    assert.equal(
      await saveReadingEdit(REF.classId, REF.readingId, REF.teacherId, { ...SAVED, title: "New" }, db.execute),
      true,
    );
    assert.equal(db.title(), "New");
  });

  it("refuses any other change to a published reading", async () => {
    for (const change of [
      { bodyText: "other body" },
      { gradeLevel: null },
      { gradeLevel: "6" as const },
      { questionCount: 3 },
      { questionMode: "per_student" as const },
    ]) {
      const db = publishedReading();
      const edit = { ...SAVED, title: "New", ...change };
      assert.equal(
        await saveReadingEdit(REF.classId, REF.readingId, REF.teacherId, edit, db.execute),
        false,
        JSON.stringify(change),
      );
      assert.equal(db.title(), "Old");
    }
    assert.equal(PUBLISHED_TITLE_ONLY_MESSAGE, "This reading is published. Only its title can be changed.");
  });
});

describe("planDelete", () => {
  const qs = [
    { id: "a", position: 1, prompt: "A" },
    { id: "b", position: 2, prompt: "B" },
    { id: "c", position: 3, prompt: "C" },
  ];

  it("lowers the count and closes the gap", () => {
    const plan = planDelete(qs, "b", 3);
    assert.deepEqual(plan, {
      ok: true,
      questionCount: 2,
      remaining: [
        { id: "a", position: 1, prompt: "A" },
        { id: "c", position: 2, prompt: "C" },
      ],
    });
  });

  it("renumbers from 1 when the first goes", () => {
    const plan = planDelete(qs, "a", 3);
    assert.ok(plan.ok);
    assert.deepEqual(plan.remaining.map((q) => q.position), [1, 2]);
  });

  it("refuses the last question", () => {
    assert.deepEqual(planDelete([qs[0]], "a", 1), { ok: false, error: LAST_QUESTION_MESSAGE });
    assert.equal(LAST_QUESTION_MESSAGE, "A reading needs at least 1 question.");
  });

  it("refuses an unknown question", () => {
    assert.deepEqual(planDelete(qs, "z", 3), { ok: false, error: READING_CHANGED_MESSAGE });
  });
});

describe("checkPublish", () => {
  it("needs exactly question_count shared questions", () => {
    assert.deepEqual(checkPublish("shared", 3, 3), { ok: true });
    assert.deepEqual(checkPublish("shared", 3, 0), { ok: false, error: PUBLISH_NEEDS_QUESTIONS_MESSAGE });
    assert.deepEqual(checkPublish("shared", 3, 2), { ok: false, error: READING_CHANGED_MESSAGE });
  });

  it("needs nothing stored in per-student mode", () => {
    assert.deepEqual(checkPublish("per_student", 3, 0), { ok: true });
  });

  it("publish statement checks the count unless per-student", () => {
    const [, publish] = publishStatements(REF);
    assert.match(publish.text, /set status = 'published'/);
    assert.match(publish.text, /r\.question_mode = 'per_student'/);
    assert.match(publish.text, /\) = r\.question_count/);
  });
});
