// Statements for a shared ("Same for everyone") reading's questions, and
// the pure rules behind them. No imports except types, so tests can check
// every statement with a fake executor. The server-only runner is
// shared-questions-db.ts.
//
// The lock rule: once a reading is published its questions are locked.
// Every write here runs as ONE READ COMMITTED transaction that starts by
// locking the reading row, only if it is still a draft and the teacher's
// (FOR UPDATE re-checks that after any wait). Every later statement is
// guarded by the same draft check, run under a fresh snapshot after the
// lock. So a publish that commits first makes the lock return no row and
// every guarded write a no-op; a write that locks first makes the publish
// wait until it commits, and the publish then counts what it wrote.
//
// The count rule: question_count is the number the teacher picked, and
// the shared set is either empty (not written yet) or exactly that long.
// Writing a set inserts exactly question_count; deleting a question lowers
// question_count by 1 in the same statement; editing the reading's text,
// grade, count, or mode clears the set (see editReadingStatements).

import type { GradeLevel } from "./grade-levels";
import type { Statement } from "./link-rate-limit";
import type { QuestionMode } from "./question-modes";

export type ReadingRef = {
  classId: string;
  readingId: string;
  teacherId: string;
};

export const PUBLISHED_LOCKED_MESSAGE =
  "This reading is published. Its questions are locked.";
export const PUBLISHED_TITLE_ONLY_MESSAGE =
  "This reading is published. Only its title can be changed.";
export const LAST_QUESTION_MESSAGE = "A reading needs at least 1 question.";
export const READING_CHANGED_MESSAGE =
  "This reading changed. Refresh the page and try again.";
export const QUESTIONS_EXIST_MESSAGE =
  "This reading already has questions. Use Regenerate all to replace them.";

// $1 reading, $2 class, $3 teacher in every statement below.
function refParams(ref: ReadingRef): unknown[] {
  return [ref.readingId, ref.classId, ref.teacherId];
}

const OWNED = `r.id = $1::uuid and r.class_id = $2::uuid and c.teacher_id = $3::uuid`;

// Locks the reading row while it is an owned draft. Returns no row (and
// locks nothing) once it's published or isn't the teacher's.
export function lockDraftStatement(ref: ReadingRef): Statement {
  return {
    text: `select r.id from readings r join classes c on c.id = r.class_id
where ${OWNED} and r.status = 'draft'
for update of r`,
    params: refParams(ref),
  };
}

// True while the reading is an owned shared-mode draft.
const DRAFT_SHARED = `exists (
  select 1 from readings r join classes c on c.id = r.class_id
  where ${OWNED} and r.status = 'draft' and r.question_mode = 'shared'
)`;

// What the questions were written from. A set is saved only if the reading
// still matches, so a set written for text the teacher has since changed
// is dropped, not saved.
export type QuestionFingerprint = {
  bodyMd5: string;
  gradeLevel: GradeLevel;
  questionCount: number;
};

// Saves a freshly written set. "generate" only saves when the set is
// empty; "replace" (regenerate all) deletes the old set first, in the same
// transaction. Applied when the insert returns exactly prompts.length rows.
export function writeSetStatements(
  ref: ReadingRef,
  fingerprint: QuestionFingerprint,
  prompts: string[],
  mode: "generate" | "replace",
): Statement[] {
  const matches = `exists (
  select 1 from readings r join classes c on c.id = r.class_id
  where ${OWNED} and r.status = 'draft' and r.question_mode = 'shared'
    and r.question_count = $4::int
    and md5(r.body_text) = $5::text
    and coalesce(r.grade_level, c.grade_level) = $6::grade_level
)`;
  const fp = [
    fingerprint.questionCount,
    fingerprint.bodyMd5,
    fingerprint.gradeLevel,
  ];
  const statements: Statement[] = [lockDraftStatement(ref)];
  if (mode === "replace") {
    statements.push({
      text: `delete from questions
where reading_id = $1::uuid and student_id is null
  and ${matches}`,
      params: [...refParams(ref), ...fp],
    });
  }
  statements.push({
    text: `insert into questions (reading_id, student_id, position, prompt)
select $1::uuid, null, p.position, p.prompt
from unnest($7::int[], $8::text[]) as p(position, prompt)
where ${matches}
  and $9::int = $4::int
  and not exists (
    select 1 from questions where reading_id = $1::uuid and student_id is null
  )
returning id`,
    params: [
      ...refParams(ref),
      ...fp,
      prompts.map((_, i) => i + 1),
      prompts,
      prompts.length,
    ],
  });
  return statements;
}

// Changes one question's text. Applied when the update returns a row.
export function updateQuestionStatements(
  ref: ReadingRef,
  questionId: string,
  prompt: string,
): Statement[] {
  return [
    lockDraftStatement(ref),
    {
      text: `update questions set prompt = $5::text
where id = $4::uuid and reading_id = $1::uuid and student_id is null
  and ${DRAFT_SHARED}
returning id`,
      params: [...refParams(ref), questionId, prompt],
    },
  ];
}

// Deletes one question, lowers question_count by 1, and renumbers the rest
// 1..N with no gaps. Refused when it's the last question.
//
// Renumbering goes through negative positions: shifting 3 -> 2 and 4 -> 3
// in one UPDATE can collide on the unique (reading, student, position)
// index, depending on row order. Negating first gives every row a free
// slot; the second update then numbers them in their original order.
// Applied when statement 2 returns the new count.
export function deleteQuestionStatements(
  ref: ReadingRef,
  questionId: string,
): Statement[] {
  const shared = `reading_id = $1::uuid and student_id is null`;
  return [
    lockDraftStatement(ref),
    {
      text: `with deleted as (
  delete from questions
  where id = $4::uuid and ${shared}
    and ${DRAFT_SHARED}
    and (select question_count from readings where id = $1::uuid) > 1
  returning id
)
update readings set question_count = question_count - 1
where id = $1::uuid and exists (select 1 from deleted)
returning question_count`,
      params: [...refParams(ref), questionId],
    },
    {
      text: `update questions set position = -position
where ${shared} and position > 0 and ${DRAFT_SHARED}`,
      params: refParams(ref),
    },
    {
      text: `update questions q set position = n.rn
from (
  select id, row_number() over (order by position desc) as rn
  from questions where ${shared} and position < 0
) n
where q.id = n.id`,
      params: [ref.readingId],
    },
  ];
}

// Publishes the draft. Shared mode needs exactly question_count questions;
// per-student mode needs none stored. Applied when it returns a row.
export function publishStatements(ref: ReadingRef): Statement[] {
  return [
    lockDraftStatement(ref),
    {
      text: `update readings r set status = 'published'
from classes c
where c.id = r.class_id and ${OWNED} and r.status = 'draft'
  and (
    r.question_mode = 'per_student'
    or (
      select count(*) from questions q
      where q.reading_id = r.id and q.student_id is null
    ) = r.question_count
  )
returning r.id`,
      params: refParams(ref),
    },
  ];
}

export type DraftEdit = {
  title: string;
  bodyText: string;
  gradeLevel: GradeLevel | null;
  questionCount: number;
  questionMode: QuestionMode;
};

// Saves the edit page, as one transaction.
//
// A draft (statements 1-3): if the text, grade override, count, or mode
// changed, the shared set no longer fits the reading, so it is cleared and
// the page asks for new questions. A title-only edit keeps them.
//
// A published reading (statement 4): only the title may change. The update
// sets nothing but the title, and only while every other field still
// equals what was sent, so any other change is refused, not dropped. It
// never touches questions. Statements 1-3 are no-ops on it (the lock
// returns no row and both writes require a draft), and statement 4 is a
// no-op on a draft, so exactly one of 3 and 4 can apply. If a publish
// commits while the teacher is editing a draft, a title-only save still
// lands; anything more is refused.
//
// Applied when statement 3 or 4 returns a row (see editApplied). The
// source link is never editable.
export function editReadingStatements(ref: ReadingRef, edit: DraftEdit): Statement[] {
  return [
    lockDraftStatement(ref),
    {
      text: `delete from questions
where reading_id = $1::uuid and student_id is null
  and exists (
    select 1 from readings r join classes c on c.id = r.class_id
    where ${OWNED} and r.status = 'draft'
      and (
        r.body_text is distinct from $4::text
        or r.grade_level is distinct from $5::grade_level
        or r.question_count <> $6::int
        or r.question_mode <> $7::question_mode
      )
  )`,
      params: [
        ...refParams(ref),
        edit.bodyText,
        edit.gradeLevel,
        edit.questionCount,
        edit.questionMode,
      ],
    },
    {
      text: `update readings r set
  title = $8::text,
  body_text = $4::text,
  grade_level = $5::grade_level,
  question_count = $6::int,
  question_mode = $7::question_mode
from classes c
where c.id = r.class_id and ${OWNED} and r.status = 'draft'
returning r.id`,
      params: [
        ...refParams(ref),
        edit.bodyText,
        edit.gradeLevel,
        edit.questionCount,
        edit.questionMode,
        edit.title,
      ],
    },
    {
      text: `update readings r set title = $8::text
from classes c
where c.id = r.class_id and ${OWNED} and r.status = 'published'
  and r.body_text = $4::text
  and r.grade_level is not distinct from $5::grade_level
  and r.question_count = $6::int
  and r.question_mode = $7::question_mode
returning r.id`,
      params: [
        ...refParams(ref),
        edit.bodyText,
        edit.gradeLevel,
        edit.questionCount,
        edit.questionMode,
        edit.title,
      ],
    },
  ];
}

// Changes a class's grade level, as one transaction. Draft readings with
// no grade override take the class's grade, so their shared questions no
// longer fit and are cleared, the same rule as editing a draft's grade.
// Readings with an override, and published readings, are untouched.
// Nothing is cleared when the grade doesn't actually change.
//
// $1 class, $2 teacher, $3 new grade.
//
// 1. Lock the class row (owned), so two grade changes queue up.
// 2. Lock the affected draft readings, with the same row lock every shared
//    question write takes first (lockDraftStatement). A set being saved
//    right now either commits before this (and step 3 deletes it) or waits
//    here, then sees the new class grade and fails its fingerprint check
//    (writeSetStatements), so a set for the old grade can't land after.
//    Locks are taken class then readings; question writes never lock the
//    class, so the two can't deadlock.
// 3. Clear those drafts' shared questions, while the class still has its
//    old grade (so "changed" is known).
// 4. Update the grade. Applied when this returns a row.
//
// Not wired to any page yet: no page edits a class's grade today.
export function classGradeChangeStatements(
  classId: string,
  teacherId: string,
  gradeLevel: GradeLevel,
): Statement[] {
  const params = [classId, teacherId, gradeLevel];
  const affected = `r.class_id = $1::uuid and r.status = 'draft' and r.grade_level is null
  and exists (
    select 1 from classes c
    where c.id = $1::uuid and c.teacher_id = $2::uuid
      and c.grade_level is distinct from $3::grade_level
  )`;
  return [
    {
      text: `select id from classes where id = $1::uuid and teacher_id = $2::uuid for update`,
      params: [classId, teacherId],
    },
    {
      text: `select r.id from readings r
where ${affected}
order by r.id
for update of r`,
      params,
    },
    {
      text: `delete from questions q
using readings r
where q.reading_id = r.id and q.student_id is null
  and ${affected}`,
      params,
    },
    {
      text: `update classes set grade_level = $3::grade_level
where id = $1::uuid and teacher_id = $2::uuid
returning id`,
      params,
    },
  ];
}

// Did editReadingStatements apply, as a draft edit or a published title
// edit?
export function editApplied(results: Record<string, unknown>[][]): boolean {
  return (results[2]?.length ?? 0) + (results[3]?.length ?? 0) > 0;
}

// Did the batch apply? Each builder's last meaningful statement returns
// rows only when it did.
export function insertedCount(results: Record<string, unknown>[][]): number {
  return results[results.length - 1]?.length ?? 0;
}

export type SharedQuestion = { id: string; position: number; prompt: string };

export type DeletePlan =
  | { ok: true; remaining: SharedQuestion[]; questionCount: number }
  | { ok: false; error: string };

// The delete rule in plain code: the last question can't go, and the rest
// close up to 1..N. The statements above enforce the same rule in SQL; the
// action uses this for its message before touching the database.
export function planDelete(
  questions: SharedQuestion[],
  questionId: string,
  questionCount: number,
): DeletePlan {
  if (!questions.some((q) => q.id === questionId)) {
    return { ok: false, error: READING_CHANGED_MESSAGE };
  }
  if (questionCount <= 1 || questions.length <= 1) {
    return { ok: false, error: LAST_QUESTION_MESSAGE };
  }
  const remaining = [...questions]
    .sort((a, b) => a.position - b.position)
    .filter((q) => q.id !== questionId)
    .map((q, i) => ({ ...q, position: i + 1 }));
  return { ok: true, remaining, questionCount: questionCount - 1 };
}

export type PublishCheck = { ok: true } | { ok: false; error: string };

export const PUBLISH_NEEDS_QUESTIONS_MESSAGE =
  "Write the questions before you publish.";

// Why a publish would be refused, for the message. The publish statement
// is still the authority.
export function checkPublish(
  mode: QuestionMode,
  questionCount: number,
  sharedQuestions: number,
): PublishCheck {
  if (mode === "per_student") return { ok: true };
  if (sharedQuestions === 0) {
    return { ok: false, error: PUBLISH_NEEDS_QUESTIONS_MESSAGE };
  }
  if (sharedQuestions !== questionCount) {
    return { ok: false, error: READING_CHANGED_MESSAGE };
  }
  return { ok: true };
}
