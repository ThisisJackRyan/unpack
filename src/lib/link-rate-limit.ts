// Per-teacher limit on link fetches from the add-reading form. Pasted text
// is never limited: the cost being limited is the outbound fetch. Every
// attempt counts, whether the fetch then works or fails.
//
// No imports, so tests can run checkLinkFetchLimit with a fake executor.
// The real executor (Neon, one transaction) is in link-fetch-attempts.ts.

export const LINK_FETCH_LIMIT = 20;
export const LINK_FETCH_WINDOW_MINUTES = 10;
// Attempts older than this are deleted as new ones are recorded.
export const LINK_FETCH_PRUNE_HOURS = 24;

export const LINK_FETCH_LIMITED_MESSAGE =
  "Slow down a sec. Try again in a few minutes.";

export type Statement = { text: string; params: unknown[] };

// Runs the statements in order as ONE READ COMMITTED transaction and
// returns each statement's rows.
export type StatementExecutor = (
  statements: Statement[],
) => Promise<Record<string, unknown>[][]>;

// Why these three statements, in one transaction:
//
// 1. Lock the teacher row (the same lock insertClassIfAllowed takes), so a
//    teacher's concurrent attempts queue up here, for a few milliseconds.
// 2. Insert the attempt only if fewer than LINK_FETCH_LIMIT were made in the
//    window. Under READ COMMITTED this statement takes a fresh snapshot after
//    the lock wait, so it counts every attempt a previous holder committed.
//    The limit is exact: a burst of 30 gets exactly 20. Without the lock,
//    concurrent requests could each count the same total and overshoot by up
//    to the number in flight. The lock costs nothing extra (same round
//    trip), so we take exactness.
// 3. Prune this teacher's rows older than LINK_FETCH_PRUNE_HOURS. It uses the
//    (teacher_id, created_at) index and touches at most a day's worth of one
//    teacher's rows, so running it every time is cheap and keeps the table
//    small without a cron job.
//
// now() is the transaction start time, which is before the lock wait. The
// window can be off by that wait (milliseconds), which doesn't matter here.
export function linkFetchStatements(teacherId: string): Statement[] {
  return [
    {
      text: "select id from teachers where id = $1::uuid for update",
      params: [teacherId],
    },
    {
      text: `insert into link_fetch_attempts (teacher_id)
select $1::uuid
where (
  select count(*) from link_fetch_attempts
  where teacher_id = $1::uuid
    and created_at > now() - make_interval(mins => $2::int)
) < $3::int
returning id`,
      params: [teacherId, LINK_FETCH_WINDOW_MINUTES, LINK_FETCH_LIMIT],
    },
    {
      text: `delete from link_fetch_attempts
where teacher_id = $1::uuid
  and created_at < now() - make_interval(hours => $2::int)`,
      params: [teacherId, LINK_FETCH_PRUNE_HOURS],
    },
  ];
}

// Records an attempt and returns true if the teacher may fetch, or false
// (recording nothing) when they're at the limit. Errors from the executor
// propagate: the caller fails closed.
export async function checkLinkFetchLimit(
  teacherId: string,
  execute: StatementExecutor,
): Promise<boolean> {
  const results = await execute(linkFetchStatements(teacherId));
  return (results[1]?.length ?? 0) > 0;
}
