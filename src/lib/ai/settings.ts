// Model call settings shared by the server-only client and the pure logic
// that has to reason about how long a call can take (the stale claim
// timeout in student-questions-core.ts). No imports, so tests can use it.

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

// Per request. A question set is short, so a call that runs past this is
// stuck, and a teacher shouldn't stare at a spinner for longer.
export const AI_TIMEOUT_MS = 30_000;

// SDK retries on connection errors, timeouts, 408/409/429/5xx. One retry
// smooths over a blip; more would keep a teacher waiting on an outage.
export const AI_MAX_RETRIES = 1;

// We call the model once, and once more if its output fails validation.
export const QUESTION_WRITE_ATTEMPTS = 2;

// The most one question write may take, end to end: both validation
// attempts, every SDK retry, and any backoff or retry-after wait between
// them. One AbortSignal.timeout covers all of it (see writeValidated); when
// it fires, the write ends as a "timeout".
//
// Why a deadline: a timeout already ends the write (it's an API error, so
// no second attempt follows), but timeouts aren't the only slow path. A
// try that times out, an SDK retry that returns invalid output, and a
// second attempt that does the same, plus backoff or a server's
// retry-after, could otherwise run past 2 minutes. The deadline is the
// real worst case, and the stale claim timeout is built on it.
export const QUESTION_WRITE_DEADLINE_MS = 110_000;

// Room for thinking plus a short tool call. Current models may think
// before answering, and thinking counts toward max_tokens.
export const QUESTION_MAX_TOKENS = 8_000;

// Question writing is a light task. Low effort keeps a call well inside
// AI_TIMEOUT_MS. Raise it here if question quality needs it.
export const QUESTION_EFFORT = "low" as const;

// The effort check: one call per attempt covers every answer. Like question
// writing, it gets one more call if its output fails validation.
export const EFFORT_CHECK_ATTEMPTS = 2;

// The most one effort check may take, end to end (both validation
// attempts, SDK retries, and backoff), the same way as
// QUESTION_WRITE_DEADLINE_MS. A student is waiting on the button, so it is
// shorter: a stuck check ends and the student can try again (a failed check
// doesn't use up a try). The stale claim timeout in submit-answers-core.ts
// is built on it.
export const EFFORT_CHECK_DEADLINE_MS = 60_000;

// Room for thinking plus up to 10 short verdicts with nudges.
export const EFFORT_CHECK_MAX_TOKENS = 6_000;

// Judging effort is a light task, and a student is waiting.
export const EFFORT_CHECK_EFFORT = "low" as const;
