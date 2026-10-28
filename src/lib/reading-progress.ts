// A student's progress on one reading, derived from their attempts,
// checks, limits, and latest challenge (the v1 spec's rule). Pure, so
// tests cover every case; the queries are in reading-progress-db.ts (the
// student's pages) and class-status.ts (the teacher's class view), and
// both go through studentReadingStatus.

import type { Statement } from "./link-rate-limit";
import { countedCheckSql, DEFAULT_LIMITS, latestChallengeSql, limitsFromRow, checksAllowedSql, triesAllowedSql, type Limits } from "./reading-limits";
import { MAX_TRIES } from "./validate-answers";

// closed: auto-closed because the student passed (see
// submit-answers-core.ts).
export type ChallengeStatus = "open" | "approved" | "denied" | "closed";

// The student's latest challenge round. `extraTry`: denied with "Give one
// more try" (the student may answer again, and send a new note if that
// try fails too).
export type LatestChallenge = { status: ChallengeStatus; extraTry: boolean };

export type StudentReadingStatus =
  | "not_started"
  | "in_progress"
  | "waiting"
  | "passed"
  | "challenged"
  | "challenge_denied";

// What the student sees. Out of tries (waiting) and a sent note
// (challenged) both read "Waiting for your teacher": either way the next
// step is the teacher's (the out-of-tries page has the note box).
export const STUDENT_READING_STATUS_LABELS: Record<StudentReadingStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  waiting: "Waiting for your teacher",
  passed: "Passed",
  challenged: "Waiting for your teacher",
  challenge_denied: "Challenge denied",
};

// What the teacher sees: the same statuses, with Challenged (a note in the
// queue) apart from Waiting for teacher (out of tries, no note yet).
export const TEACHER_READING_STATUS_LABELS: Record<StudentReadingStatus, string> = {
  ...STUDENT_READING_STATUS_LABELS,
  waiting: "Waiting for teacher",
  challenged: "Challenged",
};

// `checks` is every effort check started, failed ones included. `limits`
// defaults to MAX_TRIES and EFFORT_CHECK_LIMIT.
export type StatusInput = {
  passed: boolean;
  tries: number;
  checks: number;
  challenge: LatestChallenge | null;
  limits?: Limits;
};

// In order:
// - Passed: any attempt passed (also after a challenge, which is then
//   closed), or the teacher accepted the latest challenge.
// - Challenged: the latest challenge is open.
// - Challenge denied: the latest challenge was denied, with no extra try.
// - Waiting: every try used, or every check used (all failed on our
//   side), still not passed, and no note sent since (a used one more try
//   counts too). The answer form is gone; only a note to the teacher is
//   left. The same rule as answerStage's out_of_tries and check_limit.
// - In progress: any try, or a denial with one more try not used yet.
// - Not started.
export function studentReadingStatus(input: StatusInput): StudentReadingStatus {
  const { challenge } = input;
  const limits = input.limits ?? DEFAULT_LIMITS;
  if (input.passed || challenge?.status === "approved") return "passed";
  if (challenge?.status === "open") return "challenged";
  if (challenge?.status === "denied" && !challenge.extraTry) return "challenge_denied";
  if (input.tries >= limits.tries || input.checks >= limits.checks) return "waiting";
  if (input.tries > 0 || challenge) return "in_progress";
  return "not_started";
}

export function parseChallengeStatus(value: unknown): ChallengeStatus | null {
  return value === "open" || value === "approved" || value === "denied" || value === "closed" ? value : null;
}

// From a row with `status` (or `challenge`) and `extra_try`.
export function latestChallenge(status: unknown, extraTry: unknown): LatestChallenge | null {
  const parsed = parseChallengeStatus(status);
  return parsed ? { status: parsed, extraTry: extraTry === true } : null;
}

export type SavedAnswer = { text: string; pass: boolean; nudge: string };

export type AttemptView = {
  tryNumber: number;
  result: "pass" | "fail";
  // By question id.
  answers: Record<string, SavedAnswer>;
};

export type ReadingProgress = {
  attempts: AttemptView[];
  challenge: LatestChallenge | null;
  // Effort checks started, failed ones included (see EFFORT_CHECK_LIMIT).
  checks: number;
  limits: Limits;
};

// What the reading page shows under the questions.
export type AnswerStage =
  // Answer (again). `previous` is the last failed try, for the prefill,
  // the per-answer results, and the nudges. `extraTry`: the teacher denied
  // the note but gave one more try (exactly 1 left).
  | { kind: "answer"; tryNumber: number; maxTries: number; previous: AttemptView | null; extraTry: boolean }
  // Done: the passing try (or, when the teacher accepted a challenge, the
  // last try) shown read-only.
  | { kind: "passed"; attempt: AttemptView | null; byTeacher: boolean }
  // Every try used and no open challenge: the last try and the note box.
  // `extraTry`: that was the teacher's one more try.
  | { kind: "out_of_tries"; attempt: AttemptView | null; extraTry: boolean }
  // Every effort check used (model failures count but don't use a try)
  // with fewer than 3 tries, no pass, and no challenge yet: no answer
  // form, the last try if there is one, and the note box.
  | { kind: "check_limit"; attempt: AttemptView | null }
  // A challenge was sent and is open, or was denied without one more try
  // (no form: the teacher decided).
  | { kind: "challenged"; status: "open" | "denied"; attempt: AttemptView | null };

export function answerStage(progress: ReadingProgress): AnswerStage {
  const { attempts, challenge, checks, limits } = progress;
  const latest = attempts.at(-1) ?? null;
  const passing = attempts.find((a) => a.result === "pass");
  if (passing) return { kind: "passed", attempt: passing, byTeacher: false };
  if (challenge?.status === "approved") return { kind: "passed", attempt: latest, byTeacher: true };
  if (challenge?.status === "open") return { kind: "challenged", status: "open", attempt: latest };
  if (challenge?.status === "denied" && !challenge.extraTry) return { kind: "challenged", status: "denied", attempt: latest };
  const extraTry = challenge?.status === "denied" && challenge.extraTry;
  if (attempts.length >= limits.tries) return { kind: "out_of_tries", attempt: latest, extraTry };
  if (checks >= limits.checks) return { kind: "check_limit", attempt: latest };
  return { kind: "answer", tryNumber: attempts.length + 1, maxTries: limits.tries, previous: latest, extraTry };
}

// The class home status (studentReadingStatus) for a reading page stage,
// so the page and the list agree. The page shows it as a badge only when
// the next step is the teacher's (Waiting for your teacher): out of tries
// or every check used, with the note box still there, and a sent note.
export function stageStatus(stage: AnswerStage): StudentReadingStatus {
  switch (stage.kind) {
    case "answer":
      return stage.previous || stage.extraTry ? "in_progress" : "not_started";
    case "passed":
      return "passed";
    case "out_of_tries":
    case "check_limit":
      return "waiting";
    case "challenged":
      return stage.status === "open" ? "challenged" : "challenge_denied";
  }
}

export function stageWaitsForTeacher(stage: AnswerStage): boolean {
  const status = stageStatus(stage);
  return status === "waiting" || status === "challenged";
}

// For the page's live region, so a screen reader hears what changed after
// a check or a sent note. Empty before the first try.
export function stageAnnouncement(stage: AnswerStage): string {
  switch (stage.kind) {
    case "passed":
      return stage.byTeacher ? "Your teacher accepted your answers." : "You passed this reading. Nice work!";
    case "challenged":
      return stage.status === "open" ? "Sent. Your teacher will take a look." : "Your teacher read your note.";
    case "out_of_tries":
      return stage.extraTry
        ? "That was your extra try. Waiting for your teacher. You can still send them a note."
        : `That was try ${MAX_TRIES} of ${MAX_TRIES}. Waiting for your teacher. You can still send them a note.`;
    case "check_limit":
      return "We couldn’t check your answers. Waiting for your teacher. You can still send them a note.";
    case "answer":
      if (stage.extraTry) return "Your teacher gave you one more try. You have 1 try left.";
      return stage.previous
        ? `Not yet. ${passedCountLabel(stage.previous)} Read the tips and try again. This is try ${stage.tryNumber} of ${stage.maxTries}.`
        : "";
  }
}

// The questions locked as done: those that passed on the latest try (the
// server only takes answers for the rest; see submit-answers-core.ts).
export function lockedQuestionIds(latest: AttemptView | null): Set<string> {
  return new Set(Object.entries(latest?.answers ?? {}).filter(([, a]) => a.pass).map(([id]) => id));
}

// "2 of 3 answers passed."
export function passedCountLabel(attempt: AttemptView): string {
  const all = Object.values(attempt.answers);
  const passed = all.filter((a) => a.pass).length;
  return `${passed} of ${all.length} ${all.length === 1 ? "answer" : "answers"} passed.`;
}

// Statements for the queries, kept here so tests can check them.
// $1 student, $2 reading.

export function progressStatements(studentId: string, readingId: string): Statement[] {
  return [
    {
      text: `select a.try_number, a.result,
  coalesce(
    json_agg(json_build_object(
      'question_id', an.question_id, 'text', an.text, 'pass', an.ai_pass, 'nudge', an.ai_feedback
    )) filter (where an.id is not null),
    '[]'::json
  ) as answers
from attempts a
left join answers an on an.attempt_id = a.id
where a.student_id = $1::uuid and a.reading_id = $2::uuid
group by a.id
order by a.try_number`,
      params: [studentId, readingId],
    },
    {
      // Always one row: the latest challenge (or nulls) and the limits.
      text: `select lc.status, lc.extra_try,
  ${triesAllowedSql("$1::uuid", "$2::uuid")} as tries_allowed,
  ${checksAllowedSql("$1::uuid", "$2::uuid")} as checks_allowed
from (select 1) one
left join lateral ${latestChallengeSql("$1::uuid", "$2::uuid")} lc on true`,
      params: [studentId, readingId],
    },
    {
      text: `select count(*)::int as checks from effort_checks where student_id = $1::uuid and reading_id = $2::uuid and ${countedCheckSql()}`,
      params: [studentId, readingId],
    },
  ];
}

type AnswerJson = { question_id?: unknown; text?: unknown; pass?: unknown; nudge?: unknown };

export function readingProgress(results: Record<string, unknown>[][]): ReadingProgress {
  const attempts = (results[0] ?? []).map((row): AttemptView => {
    const answers: Record<string, SavedAnswer> = {};
    const list = (typeof row.answers === "string" ? JSON.parse(row.answers) : row.answers) as AnswerJson[];
    for (const a of list ?? []) {
      answers[String(a.question_id)] = {
        text: String(a.text ?? ""),
        pass: a.pass === true,
        nudge: typeof a.nudge === "string" ? a.nudge : "",
      };
    }
    return {
      tryNumber: Number(row.try_number),
      result: row.result === "pass" ? "pass" : "fail",
      answers,
    };
  });
  const row = results[1]?.[0];
  return {
    attempts,
    challenge: latestChallenge(row?.status, row?.extra_try),
    checks: Number(results[2]?.[0]?.checks ?? 0),
    limits: limitsFromRow(row),
  };
}

// The class's published readings, newest first, with this student's
// progress on each. $1 class, $2 student.
export function readingListStatement(classId: string, studentId: string): Statement {
  return {
    text: `select r.id, r.title, r.question_count,
  exists (
    select 1 from attempts a
    where a.reading_id = r.id and a.student_id = $2::uuid and a.result = 'pass'
  ) as passed,
  (select count(*)::int from attempts a where a.reading_id = r.id and a.student_id = $2::uuid) as tries,
  (select count(*)::int from answers an
    where an.ai_pass and an.attempt_id = (
      select a.id from attempts a where a.reading_id = r.id and a.student_id = $2::uuid order by a.try_number desc limit 1
    )) as passed_answers,
  lc.status as challenge, lc.extra_try,
  (select count(*)::int from effort_checks e where e.reading_id = r.id and e.student_id = $2::uuid and ${countedCheckSql("e")}) as checks,
  ${triesAllowedSql("$2::uuid", "r.id")} as tries_allowed,
  ${checksAllowedSql("$2::uuid", "r.id")} as checks_allowed
from readings r
left join lateral ${latestChallengeSql("$2::uuid", "r.id")} lc on true
where r.class_id = $1::uuid and r.status = 'published'
order by r.created_at desc, r.id desc`,
    params: [classId, studentId],
  };
}

export type StudentReadingListItem = {
  id: string;
  title: string;
  questionCount: number;
  status: StudentReadingStatus;
  // Answers that passed on the latest try (see done-count.ts).
  passedAnswers: number;
};

export function readingListItems(rows: Record<string, unknown>[]): StudentReadingListItem[] {
  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    questionCount: Number(row.question_count),
    passedAnswers: Number(row.passed_answers ?? 0),
    status: studentReadingStatus({
      passed: row.passed === true,
      tries: Number(row.tries ?? 0),
      checks: Number(row.checks ?? 0),
      challenge: latestChallenge(row.challenge, row.extra_try),
      limits: limitsFromRow(row),
    }),
  }));
}
