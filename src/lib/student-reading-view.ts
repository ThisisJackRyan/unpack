// What the student reading page shows, from a question lookup. Pure, so
// tests cover every status. Per-student results always go through
// studentFacingResult first, so "not_allowed" (a student outside the
// reading's class) renders exactly like "not_found" and a page can't
// reveal that the reading exists.

import {
  STUDENT_SETS_LIMITED_MESSAGE,
  studentFacingResult,
  type StudentQuestion,
  type StudentQuestionsResult,
} from "./student-questions-core";

export const QUESTIONS_ERROR_MESSAGE = "We couldn’t get your questions ready. Try again in a moment.";

// How many times the pending view refreshes itself before showing a Try
// again button. With PENDING_RETRY_AFTER_MS (2s) that is about a minute,
// longer than most question writes.
export const PENDING_MAX_REFRESHES = 30;

export type StudentReadingView =
  | { kind: "questions"; questions: StudentQuestion[] }
  | { kind: "pending"; retryAfterMs: number }
  | { kind: "limit_reached"; message: string }
  | { kind: "error"; message: string }
  | { kind: "not_found" };

// Unique per student mode. The error message is the student's own, not the
// teacher-facing QUESTION_ERROR_MESSAGES (a student can't fix "isn't set
// up yet").
export function perStudentView(result: StudentQuestionsResult): StudentReadingView {
  const facing = studentFacingResult(result);
  switch (facing.status) {
    case "ready":
      return { kind: "questions", questions: facing.questions };
    case "pending":
      return { kind: "pending", retryAfterMs: facing.retryAfterMs };
    case "limit_reached":
      return { kind: "limit_reached", message: STUDENT_SETS_LIMITED_MESSAGE };
    case "error":
      return { kind: "error", message: QUESTIONS_ERROR_MESSAGE };
    case "not_found":
      return { kind: "not_found" };
  }
}

// Same for everyone mode: the published shared set. Publishing requires a
// full set, so an empty one means something changed underneath; show the
// error view rather than an empty list.
export function sharedView(questions: StudentQuestion[]): StudentReadingView {
  return questions.length > 0
    ? { kind: "questions", questions }
    : { kind: "error", message: QUESTIONS_ERROR_MESSAGE };
}
