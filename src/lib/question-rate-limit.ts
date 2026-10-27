// Per-teacher limit on question generations: every model call a teacher
// starts (generate, regenerate all, regenerate one, sample preview) counts,
// whether it then works or fails. The automatic retry after invalid output
// is part of the same generation and doesn't count again.
//
// Student-triggered generations (a student's own set in per-student mode)
// are NOT counted here. A class of 30 opening a reading at once would
// otherwise hit the teacher's limit, and those are already bounded to once
// per student per reading (see student-questions-core.ts). To raise with
// the product owner.
//
// Same pattern as link-rate-limit.ts, against its own table. No imports
// except types, so tests run checkQuestionGenerationLimit with a fake
// executor. The real executor is in question-generation-attempts.ts.

import type { Statement, StatementExecutor } from "./link-rate-limit";

export const QUESTION_GENERATION_LIMIT = 30;
export const QUESTION_GENERATION_WINDOW_MINUTES = 10;
// Attempts older than this are deleted as new ones are recorded.
export const QUESTION_GENERATION_PRUNE_HOURS = 24;

// Teacher row lock, then a conditional insert counted under a fresh
// READ COMMITTED snapshot, then a prune: see linkFetchStatements for why
// these three statements, in this order, in one transaction.
export function questionGenerationStatements(teacherId: string): Statement[] {
  return [
    {
      text: "select id from teachers where id = $1::uuid for update",
      params: [teacherId],
    },
    {
      text: `insert into question_generation_attempts (teacher_id)
select $1::uuid
where (
  select count(*) from question_generation_attempts
  where teacher_id = $1::uuid
    and created_at > now() - make_interval(mins => $2::int)
) < $3::int
returning id`,
      params: [
        teacherId,
        QUESTION_GENERATION_WINDOW_MINUTES,
        QUESTION_GENERATION_LIMIT,
      ],
    },
    {
      text: `delete from question_generation_attempts
where teacher_id = $1::uuid
  and created_at < now() - make_interval(hours => $2::int)`,
      params: [teacherId, QUESTION_GENERATION_PRUNE_HOURS],
    },
  ];
}

// Records a generation and returns true if the teacher may call the model,
// or false (recording nothing) at the limit. Executor errors propagate, so
// the caller fails closed.
export async function checkQuestionGenerationLimit(
  teacherId: string,
  execute: StatementExecutor,
): Promise<boolean> {
  const results = await execute(questionGenerationStatements(teacherId));
  return (results[1]?.length ?? 0) > 0;
}
