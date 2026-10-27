// The self-learner reading allowance: how many new readings an account can
// start in a rolling window, and the friendly message when they're out.
// Pure (numbers, dates, SQL text), so tests cover the window edges; the
// statements run through self-readings.ts.
//
// Counting: every self_readings row the account created in the window
// that holds its slot (slot_released_at is null). Self-learners can't
// delete a reading (only the Clerk account delete removes them, and then
// the account is gone too), so live rows are the creation log. If a delete
// is ever added, count from a separate creation log instead, or a delete
// would hand a slot back.
//
// A reading whose questions never get written doesn't use a slot: when
// question writing fails (or can't start: not set up, or the account's
// question limit), the reading's slot is released (slot_released_at set,
// only while it has no questions and no live claim), so it stops counting.
// Its Try again takes the slot back in the claim itself, under the same
// account lock and only while a slot is free (see selfClaimStatements in
// self-questions-core.ts); a reading with questions always holds its slot.
// Why release rather than count only readings with questions: counting
// only finished readings would let a burst of creates (none with questions
// yet) all pass, then all generate, well past 5.
//
// Race safety: the create runs in ONE transaction that first locks the
// account row (FOR UPDATE, the lock the link and question limiters take),
// then inserts only while fewer than the allowance hold a slot in the
// window. Under READ COMMITTED the insert's fresh snapshot, taken after the
// lock wait, sees every reading (and every slot taken back) a previous
// holder committed, so 20 concurrent creates make exactly 5, and creates
// racing Try agains on released readings together never pass 5. A release
// takes no lock: it only ever frees a slot.

import type { GradeLevel } from "./grade-levels";
import type { Statement } from "./link-rate-limit";
import { dateFromRow } from "./local-time";

// The time helpers moved to local-time.ts (shared with every limiter's
// retry time); re-exported for the allowance's callers.
export { formatNextFree, resolveTimeZone } from "./local-time";

// The plan a self-learner is on. Only "free" exists; a paid plan is TBD
// (product). Add it here and in allowanceFor, and have the account's plan
// pick it (selfLearnerPlan); the core needs no other change.
export type SelfLearnerPlan = "free";

export type ReadingAllowance = { readings: number; windowDays: number };

export function allowanceFor(plan: SelfLearnerPlan): ReadingAllowance {
  switch (plan) {
    case "free":
      return { readings: 5, windowDays: 7 };
  }
}

// teachers.plan is the teacher plan (free or paid classes); self-learner
// plans aren't designed yet, so every self-learner is on free for now.
export function selfLearnerPlan(): SelfLearnerPlan {
  return "free";
}

const DAY_MS = 24 * 60 * 60 * 1000;

// When the reading created at `oldest` leaves the window, freeing a slot.
export function nextFreeAt(oldest: Date, windowDays: number): Date {
  return new Date(oldest.getTime() + windowDays * DAY_MS);
}

// Whether a creation still counts at `now`: strictly inside the window,
// the same test as the SQL (created_at > now() - window). Exactly
// windowDays old no longer counts.
export function countsAt(createdAt: Date, now: Date, windowDays: number): boolean {
  return createdAt.getTime() > now.getTime() - windowDays * DAY_MS;
}

export type AllowanceState = {
  used: number;
  remaining: number;
  // Set when none are left: when the oldest one in the window expires.
  nextFreeAt: Date | null;
};

export function allowanceState(used: number, oldest: Date | null, allowance: ReadingAllowance): AllowanceState {
  const remaining = Math.max(0, allowance.readings - used);
  return {
    used,
    remaining,
    nextFreeAt: remaining === 0 && oldest ? nextFreeAt(oldest, allowance.windowDays) : null,
  };
}

// The same, from a list of creation times (for tests and the check
// script): only those in the window count.
export function allowanceFromCreations(creations: Date[], now: Date, allowance: ReadingAllowance): AllowanceState {
  const inWindow = creations.filter((c) => countsAt(c, now, allowance.windowDays));
  const oldest = inWindow.reduce<Date | null>((min, c) => (!min || c < min ? c : min), null);
  return allowanceState(inWindow.length, oldest, allowance);
}

// "You’ve read 5 this week. Your next one frees up on Friday at 9:00 AM."
export function allowanceLimitMessage(used: number, when: string): string {
  return `You’ve read ${used} this week. Your next one frees up ${when}.`;
}

// "3 of 5 new readings left this week" ("1 of 5 new readings ...").
export function allowanceRemainingLabel(state: AllowanceState, allowance: ReadingAllowance): string {
  return `${state.remaining} of ${allowance.readings} new readings left this week`;
}

export type SelfReadingDraft = {
  title: string;
  bodyText: string;
  sourceUrl: string | null;
  gradeLevel: GradeLevel;
  questionCount: number;
};

// The readings that hold a slot: created in the window ($n: window days)
// and not released. $1 account.
export function heldSlotsSql(n: number): string {
  return `(select count(*) from self_readings
  where account_id = $1::uuid and slot_released_at is null
    and created_at > now() - make_interval(days => $${n}::int))`;
}

// The account's slot-holding creations in the window: how many, and the
// oldest. $1 account, $2 window days.
export function allowanceStatement(accountId: string, allowance: ReadingAllowance): Statement {
  return {
    text: `select count(*)::int as used, min(created_at) as oldest
from self_readings
where account_id = $1::uuid and slot_released_at is null
  and created_at > now() - make_interval(days => $2::int)`,
    params: [accountId, allowance.windowDays],
  };
}

// The create, as ONE READ COMMITTED transaction (see the top of this file):
// 1. Lock the account row.
// 2. Insert the reading only if the account is a self-learner and fewer
//    than the allowance hold a slot in the window (a fresh snapshot after
//    the lock wait, so the count is exact).
// 3. Where things stand now: the window's count and oldest, and the role.
export function createSelfReadingStatements(
  accountId: string,
  draft: SelfReadingDraft,
  allowance: ReadingAllowance,
): Statement[] {
  return [
    { text: "select id from teachers where id = $1::uuid for update", params: [accountId] },
    {
      text: `insert into self_readings (account_id, title, source_url, body_text, grade_level, question_count)
select $1::uuid, $2::text, $3::text, $4::text, $5::grade_level, $6::int
where exists (select 1 from teachers where id = $1::uuid and role = 'self_learner')
and ${heldSlotsSql(7)} < $8::int
returning id`,
      params: [
        accountId,
        draft.title,
        draft.sourceUrl,
        draft.bodyText,
        draft.gradeLevel,
        draft.questionCount,
        allowance.windowDays,
        allowance.readings,
      ],
    },
    {
      text: `select w.used, w.oldest, (select role from teachers where id = $1::uuid) as role
from (
  select count(*)::int as used, min(created_at) as oldest
  from self_readings
  where account_id = $1::uuid and slot_released_at is null
    and created_at > now() - make_interval(days => $2::int)
) w`,
      params: [accountId, allowance.windowDays],
    },
  ];
}

export type CreateOutcome =
  | { status: "created"; id: string }
  | { status: "limit_reached"; state: AllowanceState }
  // No such account, or it isn't a self-learner (now).
  | { status: "not_allowed" };

export function allowanceFromRow(row: Record<string, unknown> | undefined, allowance: ReadingAllowance): AllowanceState {
  return allowanceState(Number(row?.used ?? 0), dateFromRow(row?.oldest), allowance);
}

export function createOutcome(results: Record<string, unknown>[][], allowance: ReadingAllowance): CreateOutcome {
  const inserted = results[1]?.[0];
  if (inserted) return { status: "created", id: String(inserted.id) };
  const row = results[2]?.[0];
  if (row?.role !== "self_learner") return { status: "not_allowed" };
  return { status: "limit_reached", state: allowanceFromRow(row, allowance) };
}
