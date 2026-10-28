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
// - the same, nested in plain objects and arrays, MAX_DEPTH deep (cycle
//   safe); a plain object or array deeper than that becomes
//   { redacted: "TooDeep" };
// - any other object (a Map, a Set, a Date, a URL, a class instance) with
//   its class name only, { redacted: "Map", size: 2 } or
//   { redacted: "Box" }: its contents are never printed;
// - text, by redactLogText: an error dump or a database message that can
//   echo a row becomes REDACTED_TEXT, and a URL, an email, an IP, or a
//   token-shaped value inside other text becomes REDACTED_PART.
// Other arguments (numbers, booleans, functions) are passed through.
//
// It never throws: a getter or proxy trap that throws, or a toString that
// throws when Node formats the line, gives a fixed { redacted:
// "Unloggable" } (or a fixed line) instead of breaking the log call.
// Next logs from inside its own error handling.
//
// The text rules are best effort, and lean towards redacting. The real
// guard for a caught error is the lint rule (unpack/no-raw-error-log),
// which keeps raw errors, and text taken from them, away from log calls.

import { safeErrorFields } from "./safe-error-fields";

export const CONSOLE_METHODS = ["error", "warn", "log", "info", "debug", "trace", "dir", "assert"] as const;

export const REDACTED_TEXT = "[redacted: error text]";
export const REDACTED_PART = "[redacted]";
// The line printed when the console itself throws while formatting.
export const UNLOGGABLE_LINE = "[redacted: unloggable log line]";

// What stands in for a value that isn't printed: a class name (and a
// size for a Map or Set), "TooDeep", or "Unloggable".
export type RedactedValue = { redacted: string; size?: number };

const INSTALLED = Symbol.for("unpack.safeConsole.installed");

// How deep the wrapper walks plain objects and arrays. The argument is
// depth 0. A plain object or array at depth MAX_DEPTH is replaced by
// { redacted: "TooDeep" } (an error there still becomes its safe fields),
// so nothing past the limit is ever printed as it is. Why 5: the app's
// own log arguments are at most 3 deep (fields, causes, a cause's level);
// Node prints a console line with util.inspect's default depth 2, and %o
// with depth 4, which shows objects down to depth 4 and prints those at
// depth 5 as [Object]. So the limit cuts only what no default format
// would show, and only console.dir(x, { depth: null }) loses anything.
export const MAX_DEPTH = 5;

// Next's digests: a number as a string, maybe with "@E123" (its error
// code). Never a redirect's or not-found's digest, which hold a path.
const DIGEST_PATTERN = /^[A-Za-z0-9_@-]{1,64}$/;
const CLASS_NAME_PATTERN = /^[A-Za-z_$][\w$]{0,79}$/;

// The whole text is an error dump.
const DUMP_PATTERNS = [
  /Failed query:/,
  // A Postgres or Neon error's fields, as util.inspect or Next prints
  // them.
  /^\s*(params|detail|hint|query|internalQuery|internalPosition|constraint|routine|sourceError):/m,
  // Postgres's own where (a quoted value, or a PL/pgSQL or SQL context).
  // An app label such as "where: createReading" is kept.
  /^\s*where:\s*(['"`]|.*\b(line \d+|PL\/pgSQL|SQL (statement|function))\b)/m,
  // psql's and the server log's field lines.
  /^\s*(DETAIL|HINT|CONTEXT|STATEMENT|QUERY):/m,
  /\[cause\]/,
  // A stack frame.
  /^\s*at .+:\d+:\d+\)?\s*$/m,
];

// A database message that can echo a row's values or the input (Postgres
// quotes them, in the message or its detail).
const DATABASE_MESSAGE_PATTERNS = [
  /\bKey \(.*\)=\(/,
  /\bFailing row contains\b/i,
  /\binvalid input (syntax|value) for\b/i,
  /\bduplicate key value\b/i,
  /\bviolates (unique|foreign key|check|not-null|exclusion) constraint\b/i,
  /\bnew row for relation\b/i,
  /\bnull value in column\b/i,
  /\bvalue too long for type\b/i,
  /\bout of range\b/i,
  /\bmalformed (array|record|range) literal\b/i,
  /\bsyntax error at or near\b/i,
  /\bunterminated quoted (string|identifier)\b/i,
  /\bpassword authentication failed\b/i,
  /\b(relation|column|function|type|role|database|schema|constraint|operator|index|sequence) "[^"]*" (does not exist|already exists)\b/i,
];

// "SomeError: message" (or "Error [CODE]: message") at a line start: what
// String(error) and a stack's first line look like. Kept only when the
// message is fixed text: letters, spaces, underscores, and plain
// punctuation. A digit, a quote, or anything that frames a value
// (= : / @ $ { [ < and the like) redacts the whole text.
const ERROR_LINE = /^\s*[A-Za-z]*(Error|Exception)(\s\[[\w-]+\])?: (.*)$/gm;
const FIXED_TEXT = /^[A-Za-z_ ,.;!?()’-]*$/;

// Parts of other text that are data: replaced, the rest kept.
const PART_PATTERNS = [
  // A URL or a connection string, and a bare www. host.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>]*/gi,
  /\bwww\.[^\s'"`<>]+/gi,
  // An email.
  /[^\s@'"`<>(),;:]+@[^\s@'"`<>(),;:]+\.[A-Za-z]{2,}\b/g,
  // An IPv4 address.
  /\b\d{1,3}(\.\d{1,3}){3}\b/g,
  // Credentials: a bearer token, a JWT, Stripe-like and webhook secrets,
  // and name=value or name: value for a secret's usual names.
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(\.[A-Za-z0-9_-]*)?/g,
  /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]+/g,
  /\bwhsec_[A-Za-z0-9+/=]+/g,
  /\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|cookie)\s*[=:]\s*[^\s,;&]+/gi,
  // A Clerk id (user_2abc..., sess_..., org_...): 20 or more characters
  // after the prefix, digits or not (a base62 id can have none), or a
  // shorter one with a digit.
  /\b(user|sess|org|client|sms|idn|inv)_([A-Za-z0-9]{20,}|(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{10,})\b/g,
  // A hash or token: a long run of letters and digits (a uuid's parts
  // are shorter), or a longer base64 run with mixed case and digits.
  /\b(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{24,}\b/g,
  /(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{40,}={0,2}/g,
];

function hasUnfixedErrorLine(text: string): boolean {
  for (const match of text.matchAll(ERROR_LINE)) {
    if (!FIXED_TEXT.test(match[3])) return true;
  }
  return false;
}

// True when the whole text is to go: an error dump, a database message,
// or an error line whose message isn't fixed text.
export function looksLikeErrorDump(text: string): boolean {
  return (
    DUMP_PATTERNS.some((pattern) => pattern.test(text)) ||
    DATABASE_MESSAGE_PATTERNS.some((pattern) => pattern.test(text)) ||
    hasUnfixedErrorLine(text)
  );
}

// The text as the wrapper logs it: REDACTED_TEXT for a dump, else the
// text with each data-shaped part replaced by REDACTED_PART.
export function redactLogText(text: string): string {
  if (looksLikeErrorDump(text)) return REDACTED_TEXT;
  return PART_PATTERNS.reduce((out, pattern) => out.replace(pattern, REDACTED_PART), text);
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
  try {
    if (value instanceof Error) return true;
    if (typeof DOMException === "function" && value instanceof DOMException) return true;
    if (Object.prototype.toString.call(value) === "[object Error]") return true;
    const { name, message, stack } = value as Record<string, unknown>;
    if (typeof stack === "string") return true;
    return typeof name === "string" && typeof message === "string" && !isSafeFields(value as Record<string, unknown>);
  } catch {
    // A getter or proxy that throws: not known to be an error. The
    // wrapper then makes it { redacted: "Unloggable" } when it reads it.
    return false;
  }
}

function unloggable(): RedactedValue {
  return { redacted: "Unloggable" };
}

// A Map, a Set, a Date, a class instance: its class name, and a Map's or
// Set's size. Never its contents.
export function redactedObject(value: object): RedactedValue {
  if (value instanceof Map || value instanceof Set) {
    return { redacted: className(value, value instanceof Map ? "Map" : "Set"), size: value.size };
  }
  return { redacted: className(value, "Object") };
}

function className(value: object, fallback: string): string {
  const name = (Object.getPrototypeOf(value) as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  return typeof name === "string" && CLASS_NAME_PATTERN.test(name) ? name : fallback;
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
// common case (plain fields, no errors) passes the caller's own objects
// through. Unsure (a getter threw) counts as yes.
function needsSanitizing(value: unknown, depth: number, seen: Set<object>): boolean {
  if (typeof value === "string") return redactLogText(value) !== value;
  if (value === null || typeof value !== "object") return false;
  try {
    if (isErrorLike(value) || !isPlainContainer(value) || depth >= MAX_DEPTH) return true;
    if (seen.has(value)) return false;
    seen.add(value);
    const children = Array.isArray(value) ? Array.from({ length: value.length }, (_, i) => value[i]) : Object.values(value);
    return children.some((child) => needsSanitizing(child, depth + 1, seen));
  } catch {
    return true;
  }
}

function sanitize(value: unknown, depth: number, copies: Map<object, unknown>): unknown {
  if (typeof value === "string") return redactLogText(value);
  if (value === null || typeof value !== "object") return value;
  try {
    if (isErrorLike(value)) return errorLogFields(value);
    if (copies.has(value)) return copies.get(value);
    if (!isPlainContainer(value)) return redactedObject(value);
    if (depth >= MAX_DEPTH) return { redacted: "TooDeep" };
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      copies.set(value, out);
      for (let i = 0; i < value.length; i += 1) out.push(sanitize(value[i], depth + 1, copies));
      return out;
    }
    const out: Record<string, unknown> = Object.create(Object.getPrototypeOf(value));
    copies.set(value, out);
    for (const [key, item] of Object.entries(value)) out[key] = sanitize(item, depth + 1, copies);
    return out;
  } catch {
    return unloggable();
  }
}

export function sanitizeLogArg(value: unknown): unknown {
  try {
    if (!needsSanitizing(value, 0, new Set())) return value;
    return sanitize(value, 0, new Map());
  } catch {
    return unloggable();
  }
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
    const call = original as (...a: unknown[]) => unknown;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const self = this ?? target;
      try {
        return call.apply(self, sanitizeLogArgs(args));
      } catch {
        // Formatting threw (a toString that throws, under %s): a fixed
        // line instead, so the log call itself never throws.
        try {
          return call.apply(self, method === "assert" ? [Boolean(args[0]), UNLOGGABLE_LINE] : [UNLOGGABLE_LINE]);
        } catch {
          return undefined;
        }
      }
    };
    Object.defineProperty(wrapped, "name", { value: (original as { name: string }).name });
    (target as unknown as Record<string, unknown>)[method] = wrapped;
  }
  Object.defineProperty(flags, INSTALLED, { value: true });
  return true;
}
