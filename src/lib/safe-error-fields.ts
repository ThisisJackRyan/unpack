// The one way server code turns a caught error into log fields.
//
// An error's message is not safe to log: drizzle's DrizzleQueryError is
// "Failed query: <sql>\nparams: <params>" (Clerk ids, emails, reading
// text, answers), and Postgres and Neon messages echo input too
// (`invalid input syntax for type uuid: "..."`, a connection string). So
// this keeps only:
// - name: the error's name (or its constructor's, when the name is the
//   generic "Error"), or the value's type for a non-Error. Identifier-like
//   names only.
// - code: a short string or number code (a SQLSTATE like "23505", a
//   Node code like "ETIMEDOUT"), when there is one.
// - causes: name and code of each error under it, nearest first, through
//   `cause` (drizzle, the AI SDK, fetch) or `sourceError` (Neon), at most
//   MAX_CAUSES deep, and cycle safe.
// - timedOut: true when any level is an abort or a timeout.
// - message: only for the app's own errors in MESSAGE_ALLOWED, whose
//   messages are fixed strings with no user input.
// Never SQL, params, detail, hint, where, stacks, or the error stringified.
// Callers add their own ids (classId, readingId: app uuids).

import { DrizzleQueryError } from "drizzle-orm";
import { DeadlineError } from "./deadline";
import { FetchArticleError } from "./fetch-errors";
import { JoinCodeExhaustedError } from "./join-code";

export type SafeErrorLevel = { name: string; code?: string | number };

export type SafeErrorFields = SafeErrorLevel & {
  causes: SafeErrorLevel[];
  timedOut: boolean;
  message?: string;
};

export const MAX_CAUSES = 4;

// Messages built only from fixed text and enums. QuestionWriterError and
// EffortCheckError are left out: their reason can quote a schema problem
// in the model's output.
const MESSAGE_ALLOWED = [DeadlineError, JoinCodeExhaustedError, FetchArticleError];

const NAME_PATTERN = /^[A-Za-z_$][\w$.]{0,79}$/;
const CODE_PATTERN = /^[\w.-]{1,64}$/;

const TIMEOUT_NAMES = new Set([
  "AbortError",
  "TimeoutError",
  "ResponseAborted",
  "GatewayTimeoutError",
  "DeadlineError",
]);

const TIMEOUT_CODES = new Set<string | number>([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ABORT_ERR",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  // query_canceled: a statement timeout.
  "57014",
]);

function isErrorLike(value: unknown): value is Error {
  return value instanceof Error || (typeof DOMException === "function" && value instanceof DOMException);
}

function nameOf(value: unknown): string {
  if (!isErrorLike(value)) return value === null ? "null" : typeof value;
  // DrizzleQueryError never sets its name, so it would read "Error".
  if (value instanceof DrizzleQueryError) return "DrizzleQueryError";
  const own = value.name;
  const ctor = (value as { constructor?: { name?: unknown } }).constructor?.name;
  if (own === "Error" && typeof ctor === "string" && NAME_PATTERN.test(ctor)) return ctor;
  if (typeof own === "string" && NAME_PATTERN.test(own)) return own;
  return "Error";
}

function codeOf(value: unknown): string | number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { code } = value as { code?: unknown };
  if (typeof code === "number" && Number.isFinite(code)) return code;
  if (typeof code === "string" && CODE_PATTERN.test(code)) return code;
  return undefined;
}

function levelOf(value: unknown): SafeErrorLevel {
  const code = codeOf(value);
  return code === undefined ? { name: nameOf(value) } : { name: nameOf(value), code };
}

function isTimeout(value: unknown, level: SafeErrorLevel): boolean {
  if (TIMEOUT_NAMES.has(level.name)) return true;
  if (level.code !== undefined && TIMEOUT_CODES.has(level.code)) return true;
  return value instanceof FetchArticleError && value.kind === "timeout";
}

function nextOf(value: unknown): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const { cause, sourceError } = value as { cause?: unknown; sourceError?: unknown };
  return cause ?? sourceError;
}

export function safeErrorFields(error: unknown): SafeErrorFields {
  const top = levelOf(error);
  let timedOut = isTimeout(error, top);
  const causes: SafeErrorLevel[] = [];
  const seen = new Set<unknown>([error]);
  let current = nextOf(error);
  while (current != null && causes.length < MAX_CAUSES && !seen.has(current)) {
    seen.add(current);
    const level = levelOf(current);
    causes.push(level);
    timedOut ||= isTimeout(current, level);
    current = nextOf(current);
  }
  const fields: SafeErrorFields = { ...top, causes, timedOut };
  if (MESSAGE_ALLOWED.some((allowed) => error instanceof allowed)) fields.message = (error as Error).message;
  return fields;
}
