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
// - code: a short uppercase code (a SQLSTATE like "23505" or "57P01", a
//   Node code like "ETIMEDOUT" or "UND_ERR_SOCKET") or a finite integer
//   (an HTTP status), when there is one. Anything else (lowercase, mixed
//   case, an id-shaped value) is dropped.
// - causes: name and code of each error under it, nearest first, through
//   `cause` (drizzle, the AI SDK, fetch) or `sourceError` (Neon), at most
//   MAX_CAUSES deep, and cycle safe.
// - timedOut: true when any level is an abort or a timeout.
// - message: only for the app's own errors in MESSAGE_ALLOWED, whose
//   messages are fixed strings with no user input.
// Never SQL, params, detail, hint, where, stacks, or the error stringified.
// Callers add their own ids (classId, readingId: app uuids).

import { DrizzleQueryError } from "drizzle-orm";
import { ClerkUserNoEmailError } from "./clerk-user-errors";
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
const MESSAGE_ALLOWED = [DeadlineError, JoinCodeExhaustedError, FetchArticleError, ClerkUserNoEmailError];

const NAME_PATTERN = /^[A-Za-z_$][\w$.]{0,79}$/;
const CODE_PATTERN = /^[A-Z0-9_]{1,40}$/;

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

// An Error, a DOMException, or an Error from another realm (a vm context),
// which fails instanceof but keeps its [object Error] tag.
function isErrorLike(value: unknown): value is Error {
  return (
    value instanceof Error ||
    (typeof DOMException === "function" && value instanceof DOMException) ||
    Object.prototype.toString.call(value) === "[object Error]"
  );
}

const DRIZZLE_ENTITY_KIND = Symbol.for("drizzle:entityKind");

// By class, or by the shape its constructor gives it: a production build
// can bundle drizzle more than once (the instrumentation hook gets its own
// copy), so instanceof fails, and the class name is minified.
function isDrizzleQueryError(value: Error): boolean {
  if (value instanceof DrizzleQueryError) return true;
  const { query, params, message } = value as Error & { query?: unknown; params?: unknown };
  return typeof query === "string" && Array.isArray(params) && typeof message === "string" && message.startsWith("Failed query: ");
}

// The name rule on its own, for callers that log one level by name.
export function safeErrorName(value: unknown): string {
  if (!isErrorLike(value)) return value === null ? "null" : typeof value;
  // DrizzleQueryError never sets its name, so it would read "Error".
  if (isDrizzleQueryError(value)) return "DrizzleQueryError";
  const own = value.name;
  const ctor = (value as unknown as { constructor?: Record<string | symbol, unknown> }).constructor;
  // Drizzle's other errors carry their kind on the class, across copies.
  const kind = ctor?.[DRIZZLE_ENTITY_KIND];
  if (own === "Error" && typeof kind === "string" && NAME_PATTERN.test(kind)) return kind;
  const ctorName = ctor?.name;
  if (own === "Error" && typeof ctorName === "string" && NAME_PATTERN.test(ctorName)) return ctorName;
  if (typeof own === "string" && NAME_PATTERN.test(own)) return own;
  return "Error";
}

function codeOf(value: unknown): string | number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { code } = value as { code?: unknown };
  if (typeof code === "number" && Number.isInteger(code)) return code;
  if (typeof code === "string" && CODE_PATTERN.test(code)) return code;
  return undefined;
}

function levelOf(value: unknown): SafeErrorLevel {
  const code = codeOf(value);
  return code === undefined ? { name: safeErrorName(value) } : { name: safeErrorName(value), code };
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
