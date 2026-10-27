// What the student reading page shows, from a question lookup. Pure, so
// tests cover every status. Per-student results always go through
// studentFacingResult first, so "not_allowed" (a student outside the
// reading's class) renders exactly like "not_found" and a page can't
// reveal that the reading exists.

import { QUESTION_WRITE_DEADLINE_MS } from "./ai/settings";
import {
  PENDING_RETRY_AFTER_MS,
  STUDENT_SETS_LIMITED_MESSAGE,
  studentFacingResult,
  type StudentQuestion,
  type StudentQuestionsResult,
} from "./student-questions-core";

export const QUESTIONS_ERROR_MESSAGE = "We couldn’t get your questions ready. Try again in a moment.";

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
