import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  answersFor,
  keptLabel,
  latestTipLabel,
  teacherAnswers,
  teacherAnswersStatements,
  tryLabel,
} from "./teacher-answers";

describe("teacherAnswersStatements", () => {
  it("scopes every query to the class AND its owning teacher, in the SQL", () => {
    for (const filter of [{ readingId: "r1" }, { studentId: "s1" }, {}]) {
      const statements = teacherAnswersStatements("c1", "t1", filter);
      assert.equal(statements.length, 2);
      for (const s of statements) {
        assert.match(s.text, /where c\.id = \$1::uuid and c\.teacher_id = \$2::uuid/);
        assert.match(s.text, /join readings r on r\.class_id = c\.id/);
        assert.match(s.text, /join students s on s\.class_id = c\.id/);
        assert.match(s.text, /r\.status = 'published'/);
        assert.match(s.text, /\(\$3::uuid is null or r\.id = \$3::uuid\)/);
        assert.match(s.text, /\(\$4::uuid is null or s\.id = \$4::uuid\)/);
        // Never a self-learner table.
        assert.doesNotMatch(s.text, /\bself_/);
        assert.deepEqual(s.params.slice(0, 2), ["c1", "t1"]);
      }
    }
    assert.deepEqual(teacherAnswersStatements("c1", "t1", { readingId: "r1" })[0].params, ["c1", "t1", "r1", null]);
    assert.deepEqual(teacherAnswersStatements("c1", "t1", { studentId: "s1" })[1].params, ["c1", "t1", null, "s1"]);
  });

  it("picks the shared set, or the student's own set in per-student mode", () => {
    const [questions, tries] = teacherAnswersStatements("c1", "t1", {});
    assert.match(
      questions.text,
      /q\.student_id is not distinct from \(case when r\.question_mode = 'per_student' then s\.id end\)/,
    );
    assert.match(tries.text, /join attempts a on a\.reading_id = r\.id and a\.student_id = s\.id/);
    assert.match(tries.text, /order by a\.student_id, a\.reading_id, a\.try_number/);
  });
});

describe("teacherAnswers", () => {
  const result = teacherAnswers([
    [
      { reading_id: "r1", student_id: "s1", id: "q2", position: 2, prompt: "What did the fox do?" },
      { reading_id: "r1", student_id: "s1", id: "q1", position: 1, prompt: "Why did Mia go?" },
      { reading_id: "r1", student_id: "s2", id: "q1", position: 1, prompt: "Why did Mia go?" },
      { reading_id: "r1", student_id: "s2", id: "q2", position: 2, prompt: "What did the fox do?" },
    ],
    [
      { student_id: "s1", reading_id: "r1", try_number: 1, question_id: "q1", text: "To see the river.", ai_pass: true, ai_feedback: "" },
      { student_id: "s1", reading_id: "r1", try_number: 1, question_id: "q2", text: "idk", ai_pass: false, ai_feedback: "Look at the end again." },
      { student_id: "s1", reading_id: "r1", try_number: 2, question_id: "q1", text: "To see the river.", ai_pass: true, ai_feedback: null },
      { student_id: "s1", reading_id: "r1", try_number: 2, question_id: "q2", text: "It ran.", ai_pass: false, ai_feedback: "Where did it go?" },
      { student_id: "s1", reading_id: "r1", try_number: 3, question_id: "q1", text: "To see the river.", ai_pass: true, ai_feedback: null },
      { student_id: "s1", reading_id: "r1", try_number: 3, question_id: "q2", text: "It hid in a log.", ai_pass: true, ai_feedback: "" },
      // Not one of this pair's questions: ignored.
      { student_id: "s1", reading_id: "r1", try_number: 1, question_id: "qX", text: "?", ai_pass: false, ai_feedback: "x" },
    ],
  ]);

  it("lists each question in order with every try's answer and result", () => {
    const qs = answersFor(result, "s1", "r1");
    assert.deepEqual(qs.map((q) => q.position), [1, 2]);
    assert.deepEqual(
      qs[1].tries.map((t) => [t.tryNumber, t.text, t.pass, t.keptFrom]),
      [
        [1, "idk", false, null],
        [2, "It ran.", false, null],
        [3, "It hid in a log.", true, null],
      ],
    );
  });

  it("marks a passed answer carried into later tries as kept, from the try it passed", () => {
    const q1 = answersFor(result, "s1", "r1")[0];
    assert.deepEqual(q1.tries.map((t) => t.keptFrom), [null, 1, 1]);
    assert.deepEqual(q1.tries.map(keptLabel), ["", "Kept from try 1", "Kept from try 1"]);
    assert.equal(tryLabel(q1.tries[0]), "Try 1");
  });

  it("keeps the newest tip the student was shown, even after a later pass", () => {
    const [q1, q2] = answersFor(result, "s1", "r1");
    assert.equal(q1.latestTip, null);
    assert.deepEqual(q2.latestTip, { tryNumber: 2, text: "Where did it go?" });
    assert.equal(latestTipLabel(q2.latestTip!), "Latest tip, try 2");
  });

  it("gives a student with no tries their questions with no answers, and an unknown pair nothing", () => {
    assert.deepEqual(answersFor(result, "s2", "r1").map((q) => q.tries.length), [0, 0]);
    assert.deepEqual(answersFor(result, "s9", "r1"), []);
    assert.deepEqual(teacherAnswers([]), {});
  });
});

describe("teacher answer pages", () => {
  it("load answers with the signed-in teacher's id, never one from the request", () => {
    for (const path of [
      "../app/teacher/classes/[id]/readings/[readingId]/page.tsx",
      "../app/teacher/classes/[id]/students/[studentId]/page.tsx",
    ]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      assert.match(source, /loadTeacherAnswers\(\w+(\.id)?, (teacher\.id|teacherId), \{/, path);
      assert.match(source, /getOrCreateTeacher\(\)/, path);
      assert.match(source, /<TeacherAnswerList\b/, path);
    }
  });

  it("show Passed and Not yet as words with icons, under question headings", () => {
    const source = readFileSync(new URL("../components/teacher-answers.tsx", import.meta.url), "utf8");
    assert.match(source, /<CheckIcon \/>\s+\{ANSWER_PASSED_LABEL\}/);
    assert.match(source, /<RetryIcon \/>\s+\{ANSWER_NOT_YET_LABEL\}/);
    assert.match(source, /const Heading = headingLevel === 3 \? "h3" : "h4"/);
    assert.match(source, /<ol aria-label=\{`Tries for question/);
  });
});
