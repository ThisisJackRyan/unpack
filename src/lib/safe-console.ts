// Every server console call goes through safeErrorFields, including
// Next's own: installed by register() in src/instrumentation.ts.
//
// Next prints an uncaught server error (a page, layout, generateMetadata,
// or server action that throws) with console.error(error), or through its
// logger as console.error("⨯", error) (next/dist/server/route-modules/
// route-module.js onRequestError, next/dist/server/base-server.js logError,
// next/dist/build/output/log.js). Node then prints the error in full: a
// DrizzleQueryError's message is "Failed query: <sql>\nparams: <params>",
// and its Neon cause carries detail, hint, and where, so a failed query
// could log session hashes, Clerk ids, names, and emails.
//
// The wrapper replaces, before the real console method sees them:
// - any Error (also from another realm), DOMException, or error-like
//   object (a string stack, or a name and a message) with
//   safeErrorFields(error), plus its digest when it is a short plain
//   token, so the id the browser shows still matches the log line;
// - the same, nested in plain objects and arrays (MAX_DEPTH deep, cycle
//   safe);
// - any string that looks like an error dump (a failed query, params,
//   detail, hint or where lines, a cause, a stack) with REDACTED_TEXT.
// Other arguments are passed through as they are.

import { safeErrorFields } from "./safe-error-fields";

export const CONSOLE_METHODS = ["error", "warn", "log", "info", "debug", "trace", "dir", "assert"] as const;

export const REDACTED_TEXT = "[redacted: error text]";

const INSTALLED = Symbol.for("unpack.safeConsole.installed");
const MAX_DEPTH = 6;
// Next's digests: a number as a string, maybe with "@E123" (its error
// code). Never a redirect's or not-found's digest, which hold a path.
const DIGEST_PATTERN = /^[A-Za-z0-9_@-]{1,64}$/;

const DUMP_PATTERNS = [
  /Failed query:/,
  /^\s*(params|detail|hint|where|query|internalQuery):/m,
  /\[cause\]/,
  /^\s*at .+:\d+:\d+\)?\s*$/m,
  /^\s*[A-Za-z]*Error(\s\[[\w-]+\])?: /m,
];

export function looksLikeErrorDump(text: string): boolean {
  return DUMP_PATTERNS.some((pattern) => pattern.test(text));
}

function isPlainContainer(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// safeErrorFields' own output (or a log line built on it): already safe,
// even with a fixed app message.
function isSafeFields(value: Record<string, unknown>): boolean {
  return Array.isArray(value.causes) && typeof value.timedOut === "boolean";
}

export function isErrorLike(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (value instanceof Error) return true;
  if (typeof DOMException === "function" && value instanceof DOMException) return true;
  if (Object.prototype.toString.call(value) === "[object Error]") return true;
  try {
    const { name, message, stack } = value as Record<string, unknown>;
    if (typeof stack === "string") return true;
    return typeof name === "string" && typeof message === "string" && !isSafeFields(value as Record<string, unknown>);
  } catch {
    // A getter or proxy that throws: not an error, and left alone.
    return false;
  }
}

export function errorLogFields(error: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...safeErrorFields(error) };
  let digest: unknown;
  try {
    digest = (error as { digest?: unknown }).digest;
  } catch {
    digest = undefined;
  }
  if ((typeof digest === "string" && DIGEST_PATTERN.test(digest)) || (typeof digest === "number" && Number.isInteger(digest))) {
    fields.digest = digest;
  }
  return fields;
}

// True when the value holds anything the wrapper would change, so the
// common case (no errors) passes the caller's own objects through.
function needsSanitizing(value: unknown, depth: number, seen: Set<object>): boolean {
  if (typeof value === "string") return looksLikeErrorDump(value);
  if (value === null || typeof value !== "object") return false;
  if (isErrorLike(value)) return true;
  if (depth >= MAX_DEPTH || seen.has(value) || !isPlainContainer(value)) return false;
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => needsSanitizing(child, depth + 1, seen));
}

function sanitize(value: unknown, depth: number, copies: Map<object, unknown>): unknown {
  if (typeof value === "string") return looksLikeErrorDump(value) ? REDACTED_TEXT : value;
  if (value === null || typeof value !== "object") return value;
  if (isErrorLike(value)) return errorLogFields(value);
  if (copies.has(value)) return copies.get(value);
  if (depth >= MAX_DEPTH || !isPlainContainer(value)) return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    copies.set(value, out);
    for (const item of value) out.push(sanitize(item, depth + 1, copies));
    return out;
  }
  const out: Record<string, unknown> = Object.create(Object.getPrototypeOf(value));
  copies.set(value, out);
  for (const [key, item] of Object.entries(value)) out[key] = sanitize(item, depth + 1, copies);
  return out;
}

export function sanitizeLogArg(value: unknown): unknown {
  if (!needsSanitizing(value, 0, new Set())) return value;
  return sanitize(value, 0, new Map());
}

export function sanitizeLogArgs(args: unknown[]): unknown[] {
  return args.map(sanitizeLogArg);
}

// Wraps the console's methods once (a second call changes nothing).
// Returns whether this call installed them.
export function installSafeConsole(target: Console = console): boolean {
  const flags = target as unknown as Record<symbol, unknown>;
  if (flags[INSTALLED]) return false;
  for (const method of CONSOLE_METHODS) {
    const original = target[method] as unknown;
    if (typeof original !== "function") continue;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      return (original as (...a: unknown[]) => unknown).apply(this ?? target, sanitizeLogArgs(args));
    };
    Object.defineProperty(wrapped, "name", { value: (original as { name: string }).name });
    (target as unknown as Record<string, unknown>)[method] = wrapped;
  }
  Object.defineProperty(flags, INSTALLED, { value: true });
  return true;
}
