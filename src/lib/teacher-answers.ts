// What a teacher sees of a student's answers on a published reading: each
// question with the student's answer on every try, whether it passed on
// that try, and the latest tip (the effort check's nudge) the student was
// shown. For the teacher's reading page (every student) and the student's
// page (every reading). Pure statements and mapping, so tests check them;
// the server-only runner is teacher-answers-db.ts.
//
// Ownership is in the SQL itself: every statement joins the class and
// requires c.id = $1 AND c.teacher_id = $2, where $2 is the signed-in
// teacher's id from the server session, never a value from the client. The
// reading ($3) and student ($4) from the URL only narrow that owned set (a
// student must be in the class, a reading in it and published), so an id
// from another class or another teacher matches nothing. Self-learner
// tables (self_*) are never read: a teacher can't reach a self-learner's
// readings or answers through here.

import type { Statement } from "./link-rate-limit";
import { cellKey } from "./class-status";

const OWNED = `c.id = $1::uuid and c.teacher_id = $2::uuid`;
const NARROW = `r.status = 'published'
  and ($3::uuid is null or r.id = $3::uuid)`;

export type TeacherAnswersFilter = { readingId?: string | null; studentId?: string | null };

// $1 class, $2 teacher, $3 reading or null, $4 student or null.
export function teacherAnswersStatements(classId: string, teacherId: string, filter: TeacherAnswersFilter): Statement[] {
  const params = [classId, teacherId, filter.readingId ?? null, filter.studentId ?? null];
  return [
    {
      // The questions each student answers: the shared set, or each
      // student's own set in per-student mode.
      text: `select r.id as reading_id, s.id as student_id, q.id, q.position, q.prompt
from classes c
join readings r on r.class_id = c.id
join students s on s.class_id = c.id
join questions q on q.reading_id = r.id
  and q.student_id is not distinct from (case when r.question_mode = 'per_student' then s.id end)
where ${OWNED} and ${NARROW}
  and ($4::uuid is null or s.id = $4::uuid)
order by r.id, s.id, q.position`,
      params,
    },
    {
      // Every try's answers, in try order.
      text: `select a.student_id, a.reading_id, a.try_number, an.question_id, an.text, an.ai_pass, an.ai_feedback
from classes c
join readings r on r.class_id = c.id
join students s on s.class_id = c.id
join attempts a on a.reading_id = r.id and a.student_id = s.id
join answers an on an.attempt_id = a.id
where ${OWNED} and ${NARROW}
  and ($4::uuid is null or s.id = $4::uuid)
order by a.student_id, a.reading_id, a.try_number`,
      params,
    },
  ];
}

export type TeacherAnswerTry = {
  tryNumber: number;
  text: string;
  pass: boolean;
  // Passed on an earlier try and carried into this one unchanged (a
  // passed answer is locked, see submit-answers-core.ts): the try it came
  // from, so the page doesn't repeat it.
  keptFrom: number | null;
};

export type TeacherAnswerQuestion = {
  id: string;
  position: number;
  prompt: string;
  tries: TeacherAnswerTry[];
  // The newest tip the student was shown for this question (a nudge on an
  // answer that didn't pass), with its try; null if none.
  latestTip: { tryNumber: number; text: string } | null;
};

// By cellKey(studentId, readingId). A pair with no questions yet (a
// per-student set not made) has an empty list.
export type TeacherAnswers = Record<string, TeacherAnswerQuestion[]>;

export function teacherAnswers(results: Record<string, unknown>[][]): TeacherAnswers {
  const out: TeacherAnswers = {};
  const byQuestion = new Map<string, TeacherAnswerQuestion>();
  for (const row of results[0] ?? []) {
    const key = cellKey(String(row.student_id), String(row.reading_id));
    const question: TeacherAnswerQuestion = {
      id: String(row.id),
      position: Number(row.position),
      prompt: String(row.prompt ?? ""),
      tries: [],
      latestTip: null,
    };
    (out[key] ??= []).push(question);
    byQuestion.set(`${key}:${question.id}`, question);
  }
  for (const row of results[1] ?? []) {
    const question = byQuestion.get(`${cellKey(String(row.student_id), String(row.reading_id))}:${String(row.question_id)}`);
    if (!question) continue;
    const tryNumber = Number(row.try_number);
    const text = String(row.text ?? "");
    const pass = row.ai_pass === true;
    const before = question.tries.at(-1);
    const keptFrom = pass && before?.pass && before.text === text ? (before.keptFrom ?? before.tryNumber) : null;
    question.tries.push({ tryNumber, text, pass, keptFrom });
    const nudge = typeof row.ai_feedback === "string" ? row.ai_feedback.trim() : "";
    if (!pass && nudge) question.latestTip = { tryNumber, text: nudge };
  }
  for (const list of Object.values(out)) {
    list.sort((a, b) => a.position - b.position);
    for (const q of list) q.tries.sort((a, b) => a.tryNumber - b.tryNumber);
  }
  return out;
}

export function answersFor(answers: TeacherAnswers, studentId: string, readingId: string): TeacherAnswerQuestion[] {
  return answers[cellKey(studentId, readingId)] ?? [];
}

// Labels, shared by both pages.
export const ANSWER_PASSED_LABEL = "Passed";
export const ANSWER_NOT_YET_LABEL = "Not yet";
export const NO_TRIES_YET = "No answers yet.";
export const NO_QUESTIONS_YET = "No questions yet. They show up once the student opens this reading.";

export function tryLabel(t: TeacherAnswerTry): string {
  return `Try ${t.tryNumber}`;
}

// "Kept from try 1": a passed answer carried over unchanged.
export function keptLabel(t: TeacherAnswerTry): string {
  return t.keptFrom === null ? "" : `Kept from try ${t.keptFrom}`;
}

// "Latest tip, try 2"
export function latestTipLabel(tip: { tryNumber: number }): string {
  return `Latest tip, try ${tip.tryNumber}`;
}
