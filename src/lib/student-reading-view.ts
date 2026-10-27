// What the student reading page shows, from a question lookup. Pure, so
// tests cover every status. Per-student results always go through
// studentFacingResult first, so "not_allowed" (a student outside the
// reading's class) renders exactly like "not_found" and a page can't
// reveal that the reading exists.

import { questionErrorClass, type QuestionErrorKind } from "./ai/errors";
import { QUESTION_WRITE_DEADLINE_MS } from "./ai/settings";
import { withRetryAt, type RetryClock } from "./local-time";
import {
  PENDING_RETRY_AFTER_MS,
  STUDENT_GENERATION_THROTTLED_MESSAGE,
  STUDENT_GENERATION_USED_UP_MESSAGE,
  STUDENT_SETS_LIMITED_MESSAGE,
  studentFacingResult,
  type StudentQuestion,
  type StudentQuestionsResult,
} from "./student-questions-core";

// A transient failure (see questionErrorClass): Try again may work.
export const QUESTIONS_ERROR_MESSAGE = "We couldn’t get your questions ready. Try again in a moment.";

// Question writing is unavailable (not set up, or out of credits): trying
// again soon won't help, so no Try again button. Students: their teacher
// can be told. Self-learners: their reading is kept.
export const QUESTIONS_UNAVAILABLE_MESSAGE =
  "Your questions can’t be written right now. Please come back later, or let your teacher know.";
export const SELF_QUESTIONS_UNAVAILABLE_MESSAGE =
  "Questions can’t be written right now. Your reading is saved, so please come back later.";

// How many times the pending view refreshes itself before showing a Try
// again button: enough refreshes, PENDING_RETRY_AFTER_MS (2s) apart, to
// cover the whole QUESTION_WRITE_DEADLINE_MS (110s), plus 5 more for the
// commit and slow page loads: 60, about 2 minutes. A write still running
// is never cut off by the Try again button showing early.
export const PENDING_MAX_REFRESHES = Math.ceil(QUESTION_WRITE_DEADLINE_MS / PENDING_RETRY_AFTER_MS) + 5;

export type StudentReadingView =
  | { kind: "questions"; questions: StudentQuestion[] }
  | { kind: "pending"; retryAfterMs: number }
  | { kind: "limit_reached"; message: string }
  // The "Try again" throttle: a break (with when it ends), then Try again
  // works.
  | { kind: "throttled"; message: string }
  // Every call for this reading is used: Try again works once the teacher
  // has used "Let them try again".
  | { kind: "calls_used_up"; message: string }
  // A transient failure: the page shows Try again.
  | { kind: "error"; message: string }
  // Question writing is unavailable: no Try again button.
  | { kind: "unavailable"; message: string }
  | { kind: "not_found" };

// The error view for a failed question write, by its kind's class.
export function questionErrorView(kind: QuestionErrorKind, unavailableMessage: string): StudentReadingView {
  return questionErrorClass(kind) === "unavailable"
    ? { kind: "unavailable", message: unavailableMessage }
    : { kind: "error", message: QUESTIONS_ERROR_MESSAGE };
}

// Unique per student mode. The error message is the student's own, not the
// teacher-facing QUESTION_ERROR_MESSAGES (a student can't fix "isn't set
// up yet").
// `clock` (now and the reader's zone) turns a throttle's retry time into
// "You can try again at 2:40 PM."; without it, a relative time.
export function perStudentView(result: StudentQuestionsResult, clock: RetryClock | null = null): StudentReadingView {
  const facing = studentFacingResult(result);
  switch (facing.status) {
    case "ready":
      return { kind: "questions", questions: facing.questions };
    case "pending":
      return { kind: "pending", retryAfterMs: facing.retryAfterMs };
    case "limit_reached":
      return { kind: "limit_reached", message: STUDENT_SETS_LIMITED_MESSAGE };
    case "calls_used_up":
      return { kind: "calls_used_up", message: STUDENT_GENERATION_USED_UP_MESSAGE };
    case "throttled":
      return { kind: "throttled", message: withRetryAt(STUDENT_GENERATION_THROTTLED_MESSAGE, facing.retryAt, clock) };
    case "error":
      return questionErrorView(facing.kind, QUESTIONS_UNAVAILABLE_MESSAGE);
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

// The reading's paragraphs for the read view: split on blank lines, with
// single line breaks kept inside a paragraph.
export function readingParagraphs(bodyText: string): string[] {
  return bodyText
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

// "example.com" for a reading added from a link, without "www.", or null
// for pasted text (or a link that doesn't parse).
export function sourceHost(sourceUrl: string | null): string | null {
  if (!sourceUrl) return null;
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}
