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

// The longest one question write can hold on, in the worst case: every
// attempt times out on every SDK try.
export const QUESTION_WRITE_MAX_MS =
  QUESTION_WRITE_ATTEMPTS * (AI_MAX_RETRIES + 1) * AI_TIMEOUT_MS;

// Room for thinking plus a short tool call. Current models may think
// before answering, and thinking counts toward max_tokens.
export const QUESTION_MAX_TOKENS = 8_000;

// Question writing is a light task. Low effort keeps a call well inside
// AI_TIMEOUT_MS. Raise it here if question quality needs it.
export const QUESTION_EFFORT = "low" as const;
