// A time limit for database READS, and none for writes.
//
// The Neon HTTP driver (@neondatabase/serverless 1.2) sends every query, and
// every transaction batch, as one POST whose JSON body is
// {"query", "params"} or {"queries": [{"query", "params"}, ...]}. It has
// no timeout of its own: a stalled request waits until the function's
// maxDuration ends it, and the user sees a 504. This wraps the fetch the
// driver uses (neonConfig.fetchFunction, installed by src/db/index.ts) and
// gives a request whose every statement is a plain read DB_READ_TIMEOUT_MS
// to answer. Past that it rejects with DbReadTimeoutError, which the
// guards (answer-check-guard.ts, create-guard.ts) turn into their in-form
// timeout states.
//
// Why reads only: an aborted HTTP request does not cancel or roll back the
// statement on Neon's side. For a write the client then can't know whether
// it committed, and our writes have no idempotency key to read back by. So
// bounding a write would turn a slow success into an unknown outcome: a
// reading created twice, a weekly slot used while an error shows, a check
// claim held until it goes stale. A read has no side effects, so
// abandoning it is safe. Anything the classifier isn't sure is a read
// counts as a write (no timeout): failing that way only gives back today's
// behaviour.
//
// What counts as a plain read: an allow-list. Only a statement that is
// clearly a plain read gets the timeout; anything else, including anything
// the classifier doesn't recognise, gets none. Strings, quoted identifiers
// and comments are removed first, so a column called "updated_at" or a
// text param doesn't count. Then the statement must be:
// - one statement (no ";" between statements) starting with select or
//   with (show and explain are out: the app sends neither);
// - free of the statement words in WRITE_WORDS: insert, update, delete,
//   merge (so no data-modifying CTE), into (select into makes a table),
//   lock, set, copy, call, do, DDL, transaction control, and the like;
// - free of a locking clause (for update / for share / ...);
// - and every call in it (a name followed by "(") must be a function on
//   SAFE_FUNCTIONS, or a keyword that takes parens (PAREN_KEYWORDS: in,
//   exists, lateral, filter, ...). An unknown function, a schema-qualified
//   call (pg_catalog.foo(...)) or a quoted name called as a function
//   ("pg_advisory_lock"(1)) is not a read. A column list is not a call:
//   an alias's ("as p(a, b)"), or a CTE's ("with t(n) as (...)", found by
//   walking each WITH list, so only a name in CTE position counts). The
//   same shape elsewhere, "dblink(...) as (n int)" in FROM, is a function
//   call with a column definition list, so not a read.
// A "--" comment ends at "\n" or "\r", as in Postgres. Dollar quoting,
// E'' and U& strings, $ inside a name, non-ASCII names and unterminated
// strings or comments are left unparsed: not a read.
//
// So there is no list of functions with side effects (nextval, advisory
// locks, set_config, ...): the allow-list leaves them all out. SAFE_FUNCTIONS
// holds the functions the app's reads call, nothing more (the tests
// capture the SQL of the real read paths and check each is a read). A read
// query that starts calling a function not on it silently loses its
// timeout, which only gives back the old behaviour: add the function to
// SAFE_FUNCTIONS if it is pure. The schema has no user-defined functions,
// views or rules (drizzle/ creates none), so a name on the list is always
// the Postgres built-in.

export const DB_READ_TIMEOUT_MS = 15_000;

// A fixed message (safe-error-fields.ts logs it): the limit is on
// timeoutMs, never in the text.
export class DbReadTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super("database read timed out");
    this.name = "DbReadTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

// The driver wraps a fetch rejection in its own NeonDbError (the original
// as `sourceError`), and drizzle may wrap that again (as `cause`).
export function isDbReadTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (current instanceof Error && current.name === "DbReadTimeoutError") return true;
    const next = current as { sourceError?: unknown; cause?: unknown };
    current = next.sourceError ?? next.cause;
  }
  return false;
}

const READ_STARTS = new Set(["select", "with"]);

const WRITE_WORDS =
  /\b(insert|update|delete|merge|into|lock|set|copy|call|do|create|drop|alter|truncate|grant|revoke|comment|refresh|vacuum|analyze|analyse|cluster|reindex|notify|listen|unlisten|prepare|execute|deallocate|discard|reset|begin|commit|rollback|savepoint|release|checkpoint|import|security|nowait|skip)\b/;

const LOCKING_CLAUSE = /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/;

// The functions a plain read may call. Each is a Postgres built-in that
// only computes a value: no writes, locks, sequences, settings,
// notifications, waits or calls out.
const SAFE_FUNCTIONS = new Set([
  // Aggregates over the rows read.
  "count",
  "min",
  "max",
  "bool_or",
  "json_agg",
  // Building a value from its arguments.
  "json_build_object",
  "coalesce",
  "greatest",
  "lower",
  // Time: the transaction's start time, and an interval from numbers.
  "now",
  "make_interval",
]);

// Keywords that take a parenthesised list or subquery, so "word (" is not
// a function call. None of them names a function.
const PAREN_KEYWORDS = new Set([
  "select",
  "from",
  "where",
  "and",
  "or",
  "not",
  "in",
  "exists",
  "any",
  "all",
  "some",
  "join",
  "lateral",
  "on",
  "as",
  "filter",
  "over",
  "union",
  "intersect",
  "except",
  "when",
  "then",
  "else",
  "by",
  "having",
]);

// What stripSql leaves for a quoted identifier: a name on neither list,
// so a quoted name called as a function is an unknown call.
const QUOTED_NAME = "quoted_name";

// The statement with comments, strings and quoted identifiers taken out,
// lower-cased; null when it can't be parsed with certainty.
function stripSql(sql: string): string | null {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      // Postgres ends a line comment at "\n" or "\r" (so "\r\n" too).
      const end = sql.slice(i).search(/[\n\r]/);
      i = end === -1 ? sql.length : i + end + 1;
      out += " ";
    } else if (c === "/" && next === "*") {
      // Postgres block comments nest.
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      if (depth > 0) return null;
      out += " ";
    } else if (c === "'") {
      // An E'' string's backslash escapes aren't parsed: unsure.
      if (/[eE]$/.test(out) && !/[\w$]$/.test(out.slice(0, -1))) return null;
      // Nor are U&'' strings.
      if (/[uU]&$/.test(out)) return null;
      i += 1;
      for (;;) {
        if (i >= sql.length) return null;
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") i += 2;
          else break;
        } else i += 1;
      }
      i += 1;
      out += " '' ";
    } else if (c === '"') {
      if (/[uU]&$/.test(out)) return null;
      i += 1;
      for (;;) {
        if (i >= sql.length) return null;
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') i += 2;
          else break;
        } else i += 1;
      }
      i += 1;
      out += ` ${QUOTED_NAME} `;
    } else if (c === "$") {
      // $1 is a parameter; anything else is dollar quoting, and a $ inside
      // a name (foo$bar) isn't parsed either: unsure.
      if (!/[0-9]/.test(next ?? "") || /\w$/.test(out)) return null;
      out += c;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out.toLowerCase();
}

// Whether every "name (" in the stripped statement is allowed: a function
// on SAFE_FUNCTIONS, a keyword on PAREN_KEYWORDS, or the column list of an
// alias ("as p(a, b)") or of a CTE ("with t(n) as (...)"), which call
// nothing. A qualified name (pg_catalog.foo, or a type's modifier after ::)
// is not.
function callsAllowed(body: string): boolean {
  const cteLists = cteColumnLists(body);
  for (const match of body.matchAll(/(\w+)\s*\(/g)) {
    const name = match[1];
    const before = body.slice(0, match.index).trimEnd();
    if (before.endsWith(".") || before.endsWith(":")) return false;
    if (SAFE_FUNCTIONS.has(name) || PAREN_KEYWORDS.has(name)) continue;
    if (/\bas$/.test(before) || cteLists.has(match.index + match[0].length - 1)) continue;
    return false;
  }
  return true;
}

// The index of the ")" matching the "(" at `open`, or -1.
function closingParen(body: string, open: number): number {
  let depth = 0;
  for (let i = open; i < body.length; i += 1) {
    if (body[i] === "(") depth += 1;
    else if (body[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// The index of every "(" that opens a CTE's column list or body: "t(n)"
// and "(...)" in "with [recursive] t(n) as [not] [materialized] (...)",
// for the first CTE after each "with" (nested ones included) and each
// later one after a "," in the same list. Only that shape: "f(...) as
// (n int)" in a FROM clause is a function's column definition list, so the
// call in it still counts. Anything unexpected ends the walk of that list.
function cteColumnLists(body: string): Set<number> {
  const lists = new Set<number>();
  for (const withMatch of body.matchAll(/\bwith\b/g)) {
    let i = withMatch.index + withMatch[0].length;
    const token = (pattern: RegExp): RegExpExecArray | null => {
      pattern.lastIndex = i;
      const found = pattern.exec(body);
      if (found) i = pattern.lastIndex;
      return found;
    };
    token(/\s*recursive\b/y);
    for (;;) {
      if (!token(/\s*\w+/y)) break;
      let list = -1;
      if (token(/\s*\(/y)) {
        list = i - 1;
        const close = closingParen(body, list);
        if (close === -1) break;
        i = close + 1;
      }
      if (!token(/\s*as\s*(not\s+)?(materialized\s*)?\(/y)) break;
      if (list !== -1) lists.add(list);
      // The body's own "(", which follows "materialized" in "as not
      // materialized (".
      lists.add(i - 1);
      const close = closingParen(body, i - 1);
      if (close === -1) break;
      i = close + 1;
      if (!token(/\s*,/y)) break;
    }
  }
  return lists;
}

// Whether one SQL statement is a plain read (see the top of this file).
export function isPlainReadSql(sql: string): boolean {
  if (typeof sql !== "string") return false;
  const stripped = stripSql(sql);
  if (stripped === null) return false;
  const body = stripped.trim().replace(/[\s;]+$/, "");
  if (!body || body.includes(";")) return false;
  // Outside strings and quoted names, non-ASCII can only be part of a
  // name, which the call check below can't see whole.
  if (/[^\x00-\x7f]/.test(body)) return false;
  const first = body.match(/^\(*\s*([a-z]+)/)?.[1];
  if (!first || !READ_STARTS.has(first)) return false;
  if (WRITE_WORDS.test(body) || LOCKING_CLAUSE.test(body)) return false;
  return callsAllowed(body);
}

// Whether a driver request body is all plain reads: one query, or a batch
// whose every query is one.
export function isReadRequestBody(body: unknown): boolean {
  if (typeof body !== "string") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const { query, queries } = parsed as { query?: unknown; queries?: unknown };
  if (Array.isArray(queries)) {
    return (
      queries.length > 0 &&
      queries.every((q) => !!q && typeof q === "object" && isPlainReadSql((q as { query?: unknown }).query as string))
    );
  }
  return typeof query === "string" && isPlainReadSql(query);
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// `base` for every request, with reads given `timeoutMs` to answer: then
// the request is aborted and the call rejects with DbReadTimeoutError,
// whether or not `base` honours the abort. Writes wait as long as `base`
// does.
export function withReadTimeout(base: FetchLike, timeoutMs = DB_READ_TIMEOUT_MS): FetchLike {
  return (input, init) => {
    if (!isReadRequestBody(init?.body)) return base(input, init);
    const controller = new AbortController();
    const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new DbReadTimeoutError(timeoutMs);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
      base(input, { ...init, signal })
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    });
  };
}

// Marks the installed wrapper, so installing twice (a dev reload) doesn't
// stack timers.
const WRAPPED = Symbol.for("unpack.dbReadTimeout");

type Wrappable = FetchLike & { [WRAPPED]?: true };

// The fetch to install as neonConfig.fetchFunction: `current` (a script's
// own, say a connection cap) or the global fetch, with the read timeout.
export function readTimeoutFetchFunction(current: unknown, timeoutMs = DB_READ_TIMEOUT_MS): FetchLike {
  if (typeof current === "function" && (current as Wrappable)[WRAPPED]) return current as FetchLike;
  const base: FetchLike = typeof current === "function" ? (current as FetchLike) : (input, init) => fetch(input, init);
  const wrapped = withReadTimeout(base, timeoutMs) as Wrappable;
  wrapped[WRAPPED] = true;
  return wrapped;
}
