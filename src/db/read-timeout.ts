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
// What counts as a plain read: a single statement (no ";" between
// statements) that starts with select, with, show or explain (not explain
// analyze, which runs the statement), with none of: insert, update,
// delete, merge (so no data-modifying CTE), into (select into makes a
// table), a locking clause (for update / for share / ...), lock, set, copy,
// call, do, DDL, or a function known to have side effects (nextval,
// setval, set_config, advisory locks, pg_notify, ...). Strings, quoted
// identifiers and comments are removed first, so a column called
// "updated_at" or a text param doesn't count. Dollar quoting and E''
// strings are left unparsed and count as writes. The schema has no
// user-defined functions (drizzle/ creates none); if one with side
// effects is added, add it to SIDE_EFFECT_FUNCTIONS.

export const DB_READ_TIMEOUT_MS = 15_000;

export class DbReadTimeoutError extends Error {
  constructor(ms: number) {
    super(`database read took over ${ms} ms`);
    this.name = "DbReadTimeoutError";
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

const READ_STARTS = new Set(["select", "with", "show", "explain"]);

const WRITE_WORDS =
  /\b(insert|update|delete|merge|into|lock|set|copy|call|do|create|drop|alter|truncate|grant|revoke|comment|refresh|vacuum|analyze|analyse|cluster|reindex|notify|listen|unlisten|prepare|execute|deallocate|discard|reset|begin|commit|rollback|savepoint|release|checkpoint|import|security|nowait|skip)\b/;

const LOCKING_CLAUSE = /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/;

const SIDE_EFFECT_FUNCTIONS =
  /\b(nextval|setval|set_config|pg_(try_)?advisory\w*|pg_notify|txid_current\w*|pg_current_xact_id\w*|lo_\w+|dblink\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_switch_wal|pg_create_\w+|pg_drop_\w+|pg_logical_emit_message|pg_stat_reset\w*|pg_rotate_logfile|pg_promote|pg_file_\w+|pg_write\w*|pg_import_system_collations|pg_replication_origin_\w+)\s*\(/;

// The statement with comments, strings and quoted identifiers taken out,
// lower-cased; null when it can't be parsed with certainty.
function stripSql(sql: string): string | null {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
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
      i += 1;
      for (;;) {
        if (i >= sql.length) return null;
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') i += 2;
          else break;
        } else i += 1;
      }
      i += 1;
      out += " x ";
    } else if (c === "$") {
      // $1 is a parameter; anything else is dollar quoting: unsure.
      if (!/[0-9]/.test(next ?? "")) return null;
      out += c;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out.toLowerCase();
}

// Whether one SQL statement is a plain read (see the top of this file).
export function isPlainReadSql(sql: string): boolean {
  if (typeof sql !== "string") return false;
  const stripped = stripSql(sql);
  if (stripped === null) return false;
  const body = stripped.trim().replace(/[\s;]+$/, "");
  if (!body || body.includes(";")) return false;
  const first = body.match(/^\(*\s*([a-z]+)/)?.[1];
  if (!first || !READ_STARTS.has(first)) return false;
  if (WRITE_WORDS.test(body) || LOCKING_CLAUSE.test(body) || SIDE_EFFECT_FUNCTIONS.test(body)) return false;
  return true;
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
