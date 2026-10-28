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
import { checksAllowedSql, countedCheckSql, effortLockSql, EXTRA_TRY_CHECKS, latestChallengeSql, limitsFromRow, triesAllowedSql } from "./reading-limits";
import { latestChallenge, studentReadingStatus } from "./reading-progress";

export const CHALLENGE_DECISIONS = ["accept", "deny"] as const;
export type ChallengeDecision = (typeof CHALLENGE_DECISIONS)[number];

// The queue card's three buttons, each its own explicit choice: Accept,
// Deny, and "Deny, give one more try". (A separate checkbox could be left
// ticked while the teacher clicked Accept, and be silently ignored.)
export const DECISION_CHOICES = {
  accept: { decision: "accept", extraTry: false },
  deny: { decision: "deny", extraTry: false },
  deny_extra_try: { decision: "deny", extraTry: true },
} as const satisfies Record<string, { decision: ChallengeDecision; extraTry: boolean }>;
export type DecisionChoice = keyof typeof DECISION_CHOICES;

// The form's "decision" value, or null for anything else.
export function parseDecisionChoice(value: unknown): { decision: ChallengeDecision; extraTry: boolean } | null {
  return typeof value === "string" && Object.hasOwn(DECISION_CHOICES, value)
    ? DECISION_CHOICES[value as DecisionChoice]
    : null;
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
    (select count(*)::int from effort_checks e where e.student_id = ch.student_id and e.reading_id = ch.reading_id and ${countedCheckSql("e")}) + $6::int end
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

const OPEN_FROM = `from challenges ch
join readings r on r.id = ch.reading_id
join classes c on c.id = r.class_id
join students s on s.id = ch.student_id`;
const OPEN_WHERE = `where c.id = $1::uuid and c.teacher_id = $2::uuid and ch.status = 'open' and ${NOT_PASSED}`;
const OPEN_IN_CLASS = `${OPEN_FROM}
${OPEN_WHERE}`;

// Oldest first: the student who has waited longest. $1 class, $2 teacher.
export function queueStatements(classId: string, teacherId: string): Statement[] {
  return [
    {
      text: `select ch.id, ch.round, ch.note, ch.created_at, s.id as student_id, s.first_name, s.last_initials,
  r.id as reading_id, r.title,
  (select count(*)::int from attempts a where a.student_id = ch.student_id and a.reading_id = ch.reading_id) as tries,
  (select count(*)::int from effort_checks e where e.student_id = ch.student_id and e.reading_id = ch.reading_id and ${countedCheckSql("e")}) as checks,
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
${OPEN_FROM}
join questions q on q.reading_id = ch.reading_id
  and q.student_id is not distinct from (case when r.question_mode = 'per_student' then ch.student_id end)
left join lateral (
  select a.id from attempts a
  where a.student_id = ch.student_id and a.reading_id = ch.reading_id
  order by a.try_number desc limit 1
) la on true
left join answers an on an.attempt_id = la.id and an.question_id = q.id
${OPEN_WHERE}
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
    return {
      id: String(row.id),
      round: Number(row.round ?? 1),
      note: String(row.note ?? ""),
      createdAt: isoTime(row.created_at),
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

// Open challenges only. $1 class, $2 teacher.
export function openCountStatement(classId: string, teacherId: string): Statement {
  return {
    text: `select count(*)::int as open ${OPEN_IN_CLASS}`,
    params: [classId, teacherId],
  };
}

// Out of tries, no note yet: students in the Waiting status
// (studentReadingStatus) on one of the class's published readings, the
// ones the class progress table shows as "Waiting for teacher". Every try
// or every check used, no pass, and no note since: no challenge at all,
// or the latest was denied with one more try and that try is used too.
// They are listed in the queue so the teacher sees them before a note
// comes. Nothing is stored: they leave the list by themselves once the
// student sends a note (then it's an open challenge, listed as one), passes,
// or gets more tries.

export type NoNoteItem = {
  studentId: string;
  studentName: string;
  readingId: string;
  readingTitle: string;
  tries: number;
  triesAllowed: number;
  checks: number;
  checksAllowed: number;
  // When they ran out: their last try or last counted check, whichever is
  // later.
  ranOutAt: string;
};

// $1 class, $2 teacher. The where clause narrows to the Waiting candidates
// with the same columns studentReadingStatus reads; noNoteItems applies it.
export function noNoteStatement(classId: string, teacherId: string): Statement {
  return {
    text: `select s.id as student_id, s.first_name, s.last_initials, r.id as reading_id, r.title,
  lc.status as challenge, lc.extra_try, t.tries, t.checks, t.tries_allowed, t.checks_allowed,
  greatest(
    (select max(a.created_at) from attempts a where a.student_id = s.id and a.reading_id = r.id),
    (select max(e.created_at) from effort_checks e where e.student_id = s.id and e.reading_id = r.id and ${countedCheckSql("e")})
  ) as ran_out_at
from classes c
join students s on s.class_id = c.id
join readings r on r.class_id = c.id and r.status = 'published'
left join lateral ${latestChallengeSql("s.id", "r.id")} lc on true
cross join lateral (select
  (select count(*)::int from attempts a where a.student_id = s.id and a.reading_id = r.id) as tries,
  (select count(*)::int from effort_checks e where e.student_id = s.id and e.reading_id = r.id and ${countedCheckSql("e")}) as checks,
  ${triesAllowedSql("s.id", "r.id")} as tries_allowed,
  ${checksAllowedSql("s.id", "r.id")} as checks_allowed
) t
where c.id = $1::uuid and c.teacher_id = $2::uuid
  and not exists (select 1 from attempts p where p.student_id = s.id and p.reading_id = r.id and p.result = 'pass')
  and (lc.status is null or lc.status not in ('open', 'approved'))
  and (t.tries >= t.tries_allowed or t.checks >= t.checks_allowed)`,
    params: [classId, teacherId],
  };
}

function isoTime(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? "");
}

// The Waiting rows, by the same rule the student and the class view use.
export function noNoteItems(rows: Record<string, unknown>[]): NoNoteItem[] {
  return rows.flatMap((row) => {
    const limits = limitsFromRow(row);
    const tries = Number(row.tries ?? 0);
    const checks = Number(row.checks ?? 0);
    const status = studentReadingStatus({
      passed: false,
      tries,
      checks,
      challenge: latestChallenge(row.challenge, row.extra_try),
      limits,
    });
    if (status !== "waiting") return [];
    return [
      {
        studentId: String(row.student_id),
        studentName: studentDisplayName(row.first_name, row.last_initials),
        readingId: String(row.reading_id),
        readingTitle: String(row.title),
        tries,
        triesAllowed: limits.tries,
        checks,
        checksAllowed: limits.checks,
        ranOutAt: isoTime(row.ran_out_at),
      },
    ];
  });
}

// The pill on a no-note item.
export const NO_NOTE_LABEL = "Out of tries, no note yet";

// The one count on a queue card: tries, not checks (checks are an AI
// failure allowance, noise for the teacher here).
export function triesUsedLabel(tries: number, allowed: number): string {
  return `${tries} of ${allowed} ${allowed === 1 ? "try" : "tries"} used`;
}

// Under the no-note item's title.
export function noNoteHelp(name: string): string {
  return `${name} can still send you a note.`;
}

// The whole queue, one list. `at` is when the student started waiting on
// the teacher: the note's time for a challenge, the time they ran out for
// a no-note item. Oldest first, like the challenges alone: whoever has
// waited longest is on top, note or not.
export type QueueEntry =
  | { kind: "challenge"; key: string; at: string; item: QueueItem }
  | { kind: "no_note"; key: string; at: string; item: NoNoteItem };

// A (student, reading) with an open challenge is listed once, as the
// challenge, even if both reads raced a note being sent.
export function teacherQueue(challenges: QueueItem[], noNote: NoNoteItem[]): QueueEntry[] {
  const challenged = new Set(challenges.map((c) => `${c.studentId}:${c.readingId}`));
  const entries: QueueEntry[] = [
    ...challenges.map((item): QueueEntry => ({ kind: "challenge", key: item.id, at: item.createdAt, item })),
    ...noNote
      .filter((item) => !challenged.has(`${item.studentId}:${item.readingId}`))
      .map((item): QueueEntry => ({ kind: "no_note", key: `${item.studentId}:${item.readingId}`, at: item.ranOutAt, item })),
  ];
  const time = (e: QueueEntry) => {
    const t = Date.parse(e.at);
    return Number.isNaN(t) ? Infinity : t;
  };
  return entries.sort((a, b) => time(a) - time(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// The count on the class page: every entry the queue lists.
export function queueCount(challenges: QueueItem[], noNote: NoNoteItem[]): number {
  return teacherQueue(challenges, noNote).length;
}
