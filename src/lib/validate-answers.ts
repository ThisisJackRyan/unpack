// Pure validation for a student's answers and challenge note, shared by the
// server actions and tests. No imports, so the client forms can use the
// limits (textarea maxLength and the counters).

// Tries per student per reading. Try 4 is never checked; after 3 failed
// tries only the challenge is offered. attempts_try_number_check (1 to 3)
// in the schema is the backstop.
export const MAX_TRIES = 3;

// Every effort check a student can start on one reading, for all time: the
// MAX_TRIES tries plus room for 3 model failures (a failed check doesn't
// use up a try). Once it's reached without a pass, answering stops and the
// challenge opens, however many tries were used. Enforced in
// submit-answers-core.ts and challenges-core.ts; here so the page's stage
// logic (reading-progress.ts) can use it too.
export const EFFORT_CHECK_LIMIT = 6;

// Longest answer, in characters (UTF-16 code units, which is what a
// textarea's maxLength counts). A few sentences fit easily; a pasted page
// doesn't. It also bounds what one effort check sends to the model: 10
// answers of 1,000 characters at most.
export const ANSWER_MAX_LENGTH = 1_000;

// Longest challenge note: a few sentences to the teacher.
export const CHALLENGE_NOTE_MAX_LENGTH = 500;

// Each answer is posted as `answer:<question id>`.
export const ANSWER_FIELD_PREFIX = "answer:";

export const ANSWER_EMPTY_MESSAGE = "Write an answer here first.";
export const ANSWER_TOO_LONG_MESSAGE = "This answer is too long. Make it shorter.";
export const ANSWERS_STALE_MESSAGE = "This page is out of date. Reload it and try again.";
export const ANSWERS_FIX_MESSAGE = "Some answers need a fix. Look below.";
export const NOTE_EMPTY_MESSAGE = "Write a note to your teacher first.";
export const NOTE_TOO_LONG_MESSAGE = "This note is too long. Make it shorter.";

// Cleans what a student typed: Unicode NFC, line breaks made "\n" (a
// browser posts "\r\n", but counts it as 1 for maxLength), other control
// characters and invisible format characters dropped, tabs made spaces,
// spaces trimmed at line ends, at most one blank line in a row, and the
// whole thing trimmed.
export function sanitizeStudentText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "")
    .replace(/[  ]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type AnswerEntry = { questionId: string; value: unknown };

// The answer fields of a submitted form, in order, duplicates kept (so a
// doubled field is caught, not silently dropped).
export function answerEntries(entries: Iterable<[string, unknown]>): AnswerEntry[] {
  const out: AnswerEntry[] = [];
  for (const [name, value] of entries) {
    if (name.startsWith(ANSWER_FIELD_PREFIX)) {
      out.push({ questionId: name.slice(ANSWER_FIELD_PREFIX.length), value });
    }
  }
  return out;
}

export type AnswerErrors = Record<string, string>;

export type ValidAnswer = { questionId: string; text: string };

export type AnswersValidation =
  | { ok: true; answers: ValidAnswer[] }
  // `stale`: the posted ids aren't exactly this student's questions (an
  // old tab, or a tampered form). Shown as ANSWERS_STALE_MESSAGE.
  | { ok: false; stale: true }
  | { ok: false; stale: false; errors: AnswerErrors };

// `questionIds` is the student's own set for the reading, in order. Every
// one must be answered exactly once, with no other ids. Each answer is
// sanitized, then must be 1 to ANSWER_MAX_LENGTH characters. Answers come
// back in question order.
export function validateAnswers(questionIds: string[], entries: AnswerEntry[]): AnswersValidation {
  const byId = new Map<string, unknown>();
  for (const entry of entries) {
    if (byId.has(entry.questionId)) return { ok: false, stale: true };
    byId.set(entry.questionId, entry.value);
  }
  if (byId.size !== questionIds.length || !questionIds.every((id) => byId.has(id))) {
    return { ok: false, stale: true };
  }

  const errors: AnswerErrors = {};
  const answers: ValidAnswer[] = [];
  for (const questionId of questionIds) {
    const raw = byId.get(questionId);
    const text = typeof raw === "string" ? sanitizeStudentText(raw) : "";
    if (!text) errors[questionId] = ANSWER_EMPTY_MESSAGE;
    else if (text.length > ANSWER_MAX_LENGTH) errors[questionId] = ANSWER_TOO_LONG_MESSAGE;
    else answers.push({ questionId, text });
  }
  if (Object.keys(errors).length > 0) return { ok: false, stale: false, errors };
  return { ok: true, answers };
}

export type NoteValidation = { ok: true; note: string } | { ok: false; error: string };

export function validateChallengeNote(value: unknown): NoteValidation {
  const note = typeof value === "string" ? sanitizeStudentText(value) : "";
  if (!note) return { ok: false, error: NOTE_EMPTY_MESSAGE };
  if (note.length > CHALLENGE_NOTE_MAX_LENGTH) return { ok: false, error: NOTE_TOO_LONG_MESSAGE };
  return { ok: true, note };
}
