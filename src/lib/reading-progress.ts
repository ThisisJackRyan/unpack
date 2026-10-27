// A student's progress on one reading, derived from their attempts and
// challenge (the v1 spec's rule): Passed if any attempt passed or a
// challenge was approved, Challenged if a challenge is open, In progress
// after any try, else Not started. Pure, so tests cover every case; the
// queries are in reading-progress-db.ts.

import type { Statement } from "./link-rate-limit";
import { MAX_TRIES } from "./validate-answers";

export type ChallengeStatus = "open" | "approved" | "denied";

export type StudentReadingStatus = "not_started" | "in_progress" | "passed" | "challenged";

export const STUDENT_READING_STATUS_LABELS: Record<StudentReadingStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  passed: "Passed",
  challenged: "Challenged",
};

export type StatusInput = { passed: boolean; tries: number; challenge: ChallengeStatus | null };

// A denied challenge goes back to In progress: the student has used their
// tries, and the teacher decides what comes next.
export function studentReadingStatus(input: StatusInput): StudentReadingStatus {
  if (input.passed || input.challenge === "approved") return "passed";
  if (input.challenge === "open") return "challenged";
  if (input.tries > 0 || input.challenge === "denied") return "in_progress";
  return "not_started";
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
  challenge: ChallengeStatus | null;
};

// What the reading page shows under the questions.
export type AnswerStage =
  // Answer (again). `previous` is the last failed try, for the prefill,
  // the per-answer results, and the nudges.
  | { kind: "answer"; tryNumber: number; previous: AttemptView | null }
  // Done: the passing try (or, when the teacher approved a challenge, the
  // last try) shown read-only.
  | { kind: "passed"; attempt: AttemptView | null; byTeacher: boolean }
  // 3 failed tries and no challenge yet: the last try and the note box.
  | { kind: "out_of_tries"; attempt: AttemptView | null }
  // A challenge was sent (open or denied).
  | { kind: "challenged"; status: "open" | "denied"; attempt: AttemptView | null };

export function answerStage(progress: ReadingProgress): AnswerStage {
  const { attempts, challenge } = progress;
  const latest = attempts.at(-1) ?? null;
  const passing = attempts.find((a) => a.result === "pass");
  if (passing) return { kind: "passed", attempt: passing, byTeacher: false };
  if (challenge === "approved") return { kind: "passed", attempt: latest, byTeacher: true };
  if (challenge) return { kind: "challenged", status: challenge, attempt: latest };
  if (attempts.length >= MAX_TRIES) return { kind: "out_of_tries", attempt: latest };
  return { kind: "answer", tryNumber: attempts.length + 1, previous: latest };
}

// For the page's live region, so a screen reader hears what changed after
// a check or a sent note. Empty before the first try.
export function stageAnnouncement(stage: AnswerStage): string {
  switch (stage.kind) {
    case "passed":
      return stage.byTeacher ? "Your teacher passed this reading." : "You passed this reading. Nice work!";
    case "challenged":
      return stage.status === "open" ? "Sent. Your teacher will take a look." : "Your teacher looked at your note.";
    case "out_of_tries":
      return `That was try ${MAX_TRIES} of ${MAX_TRIES}. You can send a note to your teacher.`;
    case "answer":
      return stage.previous
        ? `Not yet. ${passedCountLabel(stage.previous)} Read the tips and try again. This is try ${stage.tryNumber} of ${MAX_TRIES}.`
        : "";
  }
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
      text: `select status from challenges where student_id = $1::uuid and reading_id = $2::uuid`,
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
  const status = results[1]?.[0]?.status;
  const challenge =
    status === "open" || status === "approved" || status === "denied" ? status : null;
  return { attempts, challenge };
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
  (select ch.status from challenges ch where ch.reading_id = r.id and ch.student_id = $2::uuid) as challenge
from readings r
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
};

export function readingListItems(rows: Record<string, unknown>[]): StudentReadingListItem[] {
  return rows.map((row) => {
    const c = row.challenge;
    return {
      id: String(row.id),
      title: String(row.title),
      questionCount: Number(row.question_count),
      status: studentReadingStatus({
        passed: row.passed === true,
        tries: Number(row.tries ?? 0),
        challenge: c === "open" || c === "approved" || c === "denied" ? c : null,
      }),
    };
  });
}
