// The teacher's challenge queue: the open challenges in a class, with
// everything needed to decide (the student's last try, question by
// question, with the effort check's result and nudge; tries and checks
// used; the note), and the decision itself. Pure statements, mapping, and
// flow over an injected executor, so tests run it with fakes; the
// server-only runner is challenge-queue.ts.
//
// Deciding, as ONE READ COMMITTED transaction:
// 1. Take the student's (student, reading) advisory lock, the one the
//    submit claim, commit, and challenge send take, keyed from the
//    challenge row. The counts in step 2 then can't move under it.
// 2. A conditional UPDATE: only while the challenge is open, the student
//    hasn't passed, and the reading's class is this class AND belongs to
//    this teacher (all in the same statement). Accept sets approved;
//    Deny sets denied, and with "Give one more try" also stores the new
//    limits (tries used + 1, checks used + EXTRA_TRY_CHECKS, see
//    reading-limits.ts) computed in that statement. resolved_at and
//    resolved_by are set either way.
// 3. When nothing was updated, whether the challenge is this teacher's at
//    all: "already_decided" (a double-click, a second tab, or an
//    auto-close because the student passed) or "not_found".
// So a double-click or two tabs make exactly one decision, and one grant:
// the loser matches no open row. Nothing is deleted: attempts, answers,
// effort checks, and the challenge all stay.

import type { Statement, StatementExecutor } from "./link-rate-limit";
import { studentDisplayName } from "./class-status";
import { checksAllowedSql, effortLockSql, EXTRA_TRY_CHECKS, limitsFromRow, triesAllowedSql } from "./reading-limits";

export const CHALLENGE_DECISIONS = ["accept", "deny"] as const;
export type ChallengeDecision = (typeof CHALLENGE_DECISIONS)[number];

export function isChallengeDecision(value: unknown): value is ChallengeDecision {
  return typeof value === "string" && (CHALLENGE_DECISIONS as readonly string[]).includes(value);
}

export type DecideInput = {
  challengeId: string;
  classId: string;
  teacherId: string;
  decision: ChallengeDecision;
  // Deny only; ignored for Accept.
  extraTry: boolean;
};

export type DecideResult =
  | { status: "accepted" }
  | { status: "denied"; extraTry: boolean }
  | { status: "already_decided" }
  | { status: "not_found" };

// Open and still worth deciding: not passed since (the passing commit
// closes it too; this also hides any row that slipped through).
const NOT_PASSED = `not exists (
  select 1 from attempts p where p.student_id = ch.student_id and p.reading_id = ch.reading_id and p.result = 'pass'
)`;

// $1 challenge, $2 teacher, $3 class, $4 status, $5 grant, $6 extra checks.
export function decideStatements(input: DecideInput): Statement[] {
  const grant = input.decision === "deny" && input.extraTry;
  return [
    {
      text: `select ${effortLockSql("ch.student_id", "ch.reading_id")} from challenges ch where ch.id = $1::uuid`,
      params: [input.challengeId],
    },
    {
      text: `update challenges ch set status = $4::challenge_status, resolved_at = now(), resolved_by = $2::uuid,
  tries_allowed = case when $5::boolean then
    (select count(*)::int from attempts a where a.student_id = ch.student_id and a.reading_id = ch.reading_id) + 1 end,
  checks_allowed = case when $5::boolean then
    (select count(*)::int from effort_checks e where e.student_id = ch.student_id and e.reading_id = ch.reading_id) + $6::int end
from readings r, classes c
where ch.id = $1::uuid and r.id = ch.reading_id and c.id = r.class_id
  and c.id = $3::uuid and c.teacher_id = $2::uuid
  and ch.status = 'open'
  and ${NOT_PASSED}
returning ch.status, ch.tries_allowed, ch.checks_allowed`,
      params: [
        input.challengeId,
        input.teacherId,
        input.classId,
        input.decision === "accept" ? "approved" : "denied",
        grant,
        EXTRA_TRY_CHECKS,
      ],
    },
    {
      // $1 challenge, $2 teacher, $3 class.
      text: `select ch.status from challenges ch
join readings r on r.id = ch.reading_id
join classes c on c.id = r.class_id
where ch.id = $1::uuid and c.id = $3::uuid and c.teacher_id = $2::uuid`,
      params: [input.challengeId, input.teacherId, input.classId],
    },
  ];
}

export function decideOutcome(results: Record<string, unknown>[][]): DecideResult {
  const row = results[1]?.[0];
  if (row) {
    if (row.status === "approved") return { status: "accepted" };
    return { status: "denied", extraTry: row.tries_allowed !== null && row.tries_allowed !== undefined };
  }
  return results[2]?.[0] ? { status: "already_decided" } : { status: "not_found" };
}

// Errors propagate, so the caller fails closed.
export async function decideChallengeWith(input: DecideInput, execute: StatementExecutor): Promise<DecideResult> {
  return decideOutcome(await execute(decideStatements(input)));
}

// For the queue's live region. `name` is the student's display name.
export function decisionMessage(result: DecideResult, name: string): string {
  switch (result.status) {
    case "accepted":
      return `Accepted. ${name} passed this reading.`;
    case "denied":
      return result.extraTry ? `Denied. ${name} has 1 more try.` : `Denied. ${name} will see that you read their note.`;
    case "already_decided":
      return "Already decided. The list is up to date.";
    case "not_found":
      return "We couldn’t find that challenge. The list is up to date.";
  }
}

export const DECIDE_FAILED_MESSAGE = "We couldn’t save that. Please try again.";

// The queue.

export type QueueQuestion = {
  id: string;
  position: number;
  prompt: string;
  // From the last try; null when no try was saved (every check failed on
  // our side) or the question wasn't answered.
  answer: { text: string; pass: boolean; nudge: string } | null;
};

export type QueueItem = {
  id: string;
  round: number;
  note: string;
  createdAt: string;
  studentId: string;
  studentName: string;
  readingId: string;
  readingTitle: string;
  tries: number;
  triesAllowed: number;
  checks: number;
  checksAllowed: number;
  // The try shown, or null with no try saved.
  lastTry: number | null;
  questions: QueueQuestion[];
};

const OPEN_IN_CLASS = `from challenges ch
join readings r on r.id = ch.reading_id
join classes c on c.id = r.class_id
join students s on s.id = ch.student_id
where c.id = $1::uuid and c.teacher_id = $2::uuid and ch.status = 'open' and ${NOT_PASSED}`;

// Oldest first: the student who has waited longest. $1 class, $2 teacher.
export function queueStatements(classId: string, teacherId: string): Statement[] {
  return [
    {
      text: `select ch.id, ch.round, ch.note, ch.created_at, s.id as student_id, s.first_name, s.last_initials,
  r.id as reading_id, r.title,
  (select count(*)::int from attempts a where a.student_id = ch.student_id and a.reading_id = ch.reading_id) as tries,
  (select count(*)::int from effort_checks e where e.student_id = ch.student_id and e.reading_id = ch.reading_id) as checks,
  ${triesAllowedSql("ch.student_id", "ch.reading_id")} as tries_allowed,
  ${checksAllowedSql("ch.student_id", "ch.reading_id")} as checks_allowed,
  (select max(a.try_number) from attempts a where a.student_id = ch.student_id and a.reading_id = ch.reading_id) as last_try
${OPEN_IN_CLASS}
order by ch.created_at, ch.id`,
      params: [classId, teacherId],
    },
    {
      // Each open challenge's questions (the shared set, or the student's
      // own in per-student mode) with the last try's answers.
      text: `select ch.id as challenge_id, q.id as question_id, q.position, q.prompt,
  an.text, an.ai_pass, an.ai_feedback
${OPEN_IN_CLASS}
join questions q on q.reading_id = ch.reading_id
  and q.student_id is not distinct from (case when r.question_mode = 'per_student' then ch.student_id end)
left join lateral (
  select a.id from attempts a
  where a.student_id = ch.student_id and a.reading_id = ch.reading_id
  order by a.try_number desc limit 1
) la on true
left join answers an on an.attempt_id = la.id and an.question_id = q.id
order by ch.id, q.position`,
      params: [classId, teacherId],
    },
  ];
}

export function queueItems(results: Record<string, unknown>[][]): QueueItem[] {
  const questions = new Map<string, QueueQuestion[]>();
  for (const row of results[1] ?? []) {
    const id = String(row.challenge_id);
    const list = questions.get(id) ?? [];
    list.push({
      id: String(row.question_id),
      position: Number(row.position),
      prompt: String(row.prompt),
      answer:
        typeof row.text === "string"
          ? { text: row.text, pass: row.ai_pass === true, nudge: typeof row.ai_feedback === "string" ? row.ai_feedback : "" }
          : null,
    });
    questions.set(id, list);
  }
  return (results[0] ?? []).map((row) => {
    const limits = limitsFromRow(row);
    const created = row.created_at;
    return {
      id: String(row.id),
      round: Number(row.round ?? 1),
      note: String(row.note ?? ""),
      createdAt: created instanceof Date ? created.toISOString() : String(created ?? ""),
      studentId: String(row.student_id),
      studentName: studentDisplayName(row.first_name, row.last_initials),
      readingId: String(row.reading_id),
      readingTitle: String(row.title),
      tries: Number(row.tries ?? 0),
      triesAllowed: limits.tries,
      checks: Number(row.checks ?? 0),
      checksAllowed: limits.checks,
      lastTry: row.last_try === null || row.last_try === undefined ? null : Number(row.last_try),
      questions: (questions.get(String(row.id)) ?? []).sort((a, b) => a.position - b.position),
    };
  });
}

// The count badge on the class page. $1 class, $2 teacher.
export function openCountStatement(classId: string, teacherId: string): Statement {
  return {
    text: `select count(*)::int as open ${OPEN_IN_CLASS}`,
    params: [classId, teacherId],
  };
}
