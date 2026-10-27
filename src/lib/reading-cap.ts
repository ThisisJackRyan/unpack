// The one-time raise of a per-student reading's student set cap, from
// STUDENT_SETS_PER_READING_LIMIT (150) to STUDENT_SETS_RAISED_LIMIT (300).
// Pure statements, flow, and view logic over an injected executor, so
// tests run them with fakes and scripts/check-teacher-gaps.ts runs them
// against Postgres.
//
// The raise is ONE statement, so ONE transaction: `owned` finds the
// reading only if it is in this class, the class is this teacher's, and
// the reading is a published per-student one (the only kind with a cap);
// the insert into reading_cap_raises runs only for that row, ON CONFLICT
// (reading_id) DO NOTHING. The unique reading_id makes concurrent raises
// (a double click, two tabs) save exactly one row: under READ COMMITTED
// the others wait on the first insert's commit, then do nothing. That row
// is both the new limit and the log (who, when, from, to).
//
// Outcomes:
// - "raised": this call raised it.
// - "already_raised": the reading is theirs and was raised before. A
//   no-op with a calm message: the limit is one bump per reading.
// - "not_found": not their reading, or not a published per-student one.
//   Nothing changes.
//
// The student set claim (claimStatements in student-questions-core.ts)
// reads to_limit from this row under the reading lock, so the cap stays
// exact: never over 150 before the raise, never over 300 after.

import type { Statement, StatementExecutor } from "./link-rate-limit";
import {
  STUDENT_SETS_LIMITED_MESSAGE,
  STUDENT_SETS_PER_READING_LIMIT,
  STUDENT_SETS_RAISED_LIMIT,
} from "./student-questions-core";

// The button shows from here on (90% of the default cap), so a teacher
// can raise the limit before a student is turned away.
export const CAP_NEAR_THRESHOLD = Math.ceil(STUDENT_SETS_PER_READING_LIMIT * 0.9);

// "Almost full" for any limit: the same 15 students short of it as the
// panel's threshold on the default cap. 135 of 150, 285 of 300.
export function capNearThreshold(limit: number): number {
  return Math.max(0, limit - (STUDENT_SETS_PER_READING_LIMIT - CAP_NEAR_THRESHOLD));
}

export const CAP_RAISE_FAILED_MESSAGE = "We couldn’t raise the limit. Please try again.";

export function capRaisedMessage(limit: number): string {
  return `Limit raised to ${limit} students.`;
}

export function capAlreadyRaisedMessage(limit: number): string {
  return `The limit was already raised to ${limit} students.`;
}

// $1 class, $2 teacher, $3 reading, $4 from, $5 to.
export function raiseCapStatement(classId: string, teacherId: string, readingId: string): Statement {
  return {
    text: `with owned as (
  select r.id from readings r
  join classes c on c.id = r.class_id
  where r.id = $3::uuid and r.class_id = $1::uuid and c.teacher_id = $2::uuid
    and r.status = 'published' and r.question_mode = 'per_student'
),
raised as (
  insert into reading_cap_raises (reading_id, teacher_id, from_limit, to_limit)
  select id, $2::uuid, $4::int, $5::int from owned
  on conflict (reading_id) do nothing
  returning to_limit
)
select (select count(*) from owned)::int as owned, (select count(*) from raised)::int as raised,
  (select to_limit from raised) as to_limit`,
    params: [classId, teacherId, readingId, STUDENT_SETS_PER_READING_LIMIT, STUDENT_SETS_RAISED_LIMIT],
  };
}

export type RaiseCapResult = { status: "raised"; limit: number } | { status: "already_raised"; limit: number } | { status: "not_found" };

export async function raiseReadingCapWith(
  classId: string,
  teacherId: string,
  readingId: string,
  execute: StatementExecutor,
): Promise<RaiseCapResult> {
  const [rows = []] = await execute([raiseCapStatement(classId, teacherId, readingId)]);
  const row = rows[0];
  if (Number(row?.raised ?? 0) > 0) return { status: "raised", limit: Number(row?.to_limit ?? STUDENT_SETS_RAISED_LIMIT) };
  return Number(row?.owned ?? 0) > 0
    ? { status: "already_raised", limit: STUDENT_SETS_RAISED_LIMIT }
    : { status: "not_found" };
}

// How full the reading is: the claims (pending or done, the same count the
// cap uses) and its cap. Scoped to the owning teacher like the raise.
// $1 class, $2 teacher, $3 reading, $4 default cap.
export function readingCapStatement(classId: string, teacherId: string, readingId: string): Statement {
  return {
    text: `select
  (select count(*)::int from question_generations g where g.reading_id = r.id) as used,
  coalesce((select x.to_limit from reading_cap_raises x where x.reading_id = r.id), $4::int)::int as cap,
  exists (select 1 from reading_cap_raises x where x.reading_id = r.id) as raised
from readings r
join classes c on c.id = r.class_id
where r.id = $3::uuid and r.class_id = $1::uuid and c.teacher_id = $2::uuid`,
    params: [classId, teacherId, readingId, STUDENT_SETS_PER_READING_LIMIT],
  };
}

export type ReadingCap = { used: number; limit: number; raised: boolean };

export function readingCapFromRows(results: Record<string, unknown>[][]): ReadingCap | undefined {
  const row = results[0]?.[0];
  if (!row) return undefined;
  const cap = Number(row.cap);
  return {
    used: Number(row.used ?? 0),
    limit: Number.isInteger(cap) && cap > 0 ? cap : STUDENT_SETS_PER_READING_LIMIT,
    raised: row.raised === true,
  };
}

// What the teacher's reading page shows:
// - "none": well under the cap, not raised. Nothing.
// - "near" / "full": not raised yet, at CAP_NEAR_THRESHOLD or more, or at
//   the cap. A note and the "Raise the limit" button.
// - "raised": the new limit, with how full it is. No button.
// - "raised_full": raised, and full at the new limit. A note that it's
//   full and can't go higher. No button.
export type CapView =
  | { kind: "none" }
  | { kind: "near" | "full"; used: number; limit: number; raiseTo: number }
  | { kind: "raised" | "raised_full"; used: number; limit: number };

export function capView(cap: ReadingCap): CapView {
  if (cap.raised) return { kind: cap.used >= cap.limit ? "raised_full" : "raised", used: cap.used, limit: cap.limit };
  if (cap.used >= cap.limit) return { kind: "full", used: cap.used, limit: cap.limit, raiseTo: STUDENT_SETS_RAISED_LIMIT };
  if (cap.used >= CAP_NEAR_THRESHOLD) return { kind: "near", used: cap.used, limit: cap.limit, raiseTo: STUDENT_SETS_RAISED_LIMIT };
  return { kind: "none" };
}

export function capHeadline(view: Exclude<CapView, { kind: "none" }>): string {
  if (view.kind === "full" || view.kind === "raised_full") return `This reading is full (${view.limit} students)`;
  if (view.kind === "near") return `This reading is almost full (${view.used} of ${view.limit} students)`;
  return `Limit raised to ${view.limit} students`;
}

// The line under the headline.
export function capDetail(view: Exclude<CapView, { kind: "none" }>): string {
  switch (view.kind) {
    case "full":
      return `New students who open it now see “${STUDENT_SETS_LIMITED_MESSAGE}” Students who already have their questions keep them.`;
    case "near":
      return `Once ${view.limit} students have their own questions, new students who open it see “${STUDENT_SETS_LIMITED_MESSAGE}”`;
    case "raised":
      return `${view.used} of ${view.limit} students have their own questions. The limit can only be raised once.`;
    case "raised_full":
      return `New students who open it now see “${STUDENT_SETS_LIMITED_MESSAGE}” Students who already have their questions keep them. The limit was raised once already, so it can’t go higher.`;
  }
}

// The class page's reading list: a small badge on a published per-student
// reading near or at its limit (the default or the raised one). Near is
// from capNearThreshold of whichever limit applies, so on an unraised
// reading the badge and the panel agree.
export type CapLevel = "ok" | "near" | "full";

export function capLevel(used: number, limit: number): CapLevel {
  if (used >= limit) return "full";
  if (used >= capNearThreshold(limit)) return "near";
  return "ok";
}

export type CapBadge = { level: Exclude<CapLevel, "ok">; used: number; limit: number };

export function capBadgeLabel(level: CapBadge["level"]): string {
  return level === "full" ? "Full" : "Almost full";
}

// Read after the label by screen readers, and the badge's hover title.
export function capBadgeDetail(badge: CapBadge): string {
  return `${badge.used} of ${badge.limit} students have their own questions`;
}

// One grouped count for every published per-student reading in the class
// that has any claims, with its limit. Scoped to the owning teacher.
// $1 class, $2 teacher, $3 default cap.
export function classCapsStatement(classId: string, teacherId: string): Statement {
  return {
    text: `select r.id as reading_id, count(*)::int as used,
  coalesce(max(x.to_limit), $3::int)::int as cap
from readings r
join classes c on c.id = r.class_id
join question_generations g on g.reading_id = r.id
left join reading_cap_raises x on x.reading_id = r.id
where r.class_id = $1::uuid and c.teacher_id = $2::uuid
  and r.status = 'published' and r.question_mode = 'per_student'
group by r.id`,
    params: [classId, teacherId, STUDENT_SETS_PER_READING_LIMIT],
  };
}

// Reading id to its badge, only for readings near or at their limit.
export function classCapBadges(results: Record<string, unknown>[][]): Map<string, CapBadge> {
  const badges = new Map<string, CapBadge>();
  for (const row of results[0] ?? []) {
    const cap = Number(row.cap);
    const limit = Number.isInteger(cap) && cap > 0 ? cap : STUDENT_SETS_PER_READING_LIMIT;
    const used = Number(row.used ?? 0);
    const level = capLevel(used, limit);
    if (level !== "ok") badges.set(String(row.reading_id), { level, used, limit });
  }
  return badges;
}
