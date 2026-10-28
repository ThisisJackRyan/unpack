import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { neon, neonConfig } from "@neondatabase/serverless";
import { allowanceFor, allowanceStatement, createSelfReadingStatements } from "@/lib/self-allowance";
import {
  DB_READ_TIMEOUT_MS,
  DbReadTimeoutError,
  isDbReadTimeout,
  isPlainReadSql,
  isReadRequestBody,
  readTimeoutFetchFunction,
  withReadTimeout,
  type FetchLike,
} from "./read-timeout";

const reads = [
  "select 1",
  "SELECT 1;",
  "  select id from teachers where id = $1::uuid  ;  ",
  'select "id", "updated_at", "deleted_at" from "teachers" where "teachers"."id" = $1',
  "with w as (select count(*)::int as used from self_readings) select used from w",
  "with recursive t(n) as (select 1 union all select n + 1 from t where n < 3) select * from t",
  "(select 1) union (select 2)",
  "show timezone",
  "explain select * from readings",
  "select 'insert into x; delete from y' as text",
  "select 'it''s' as a, \"update\" from \"delete\"",
  "select 1 -- for update\n",
  "select /* insert */ 1",
  "select /* nested /* delete */ comment */ 1",
  "select now() - make_interval(days => $2::int)",
  "select r.id from readings r where r.slot_released_at is null and r.created_at > now()",
  "select exists (select 1 from classes where id = $1)",
];

const writes = [
  "insert into teachers (id) values ($1)",
  "update teachers set name = $1",
  "delete from teachers",
  "merge into t using s on true when matched then do nothing",
  "with gone as (delete from t returning id) select count(*) from gone",
  "with x as (insert into t values (1) returning id) select * from x",
  "with x as (update t set a = 1 returning id) select * from x",
  "select id from teachers where id = $1::uuid for update",
  "select id from teachers for share",
  "select id from teachers for no key update",
  "select id from teachers for key share",
  "select id from teachers for update skip locked",
  "select * into new_table from t",
  "select nextval('s')",
  "select setval('s', 1)",
  "select set_config('a', 'b', false)",
  "select pg_advisory_xact_lock($1::int, hashtext($2::text))",
  "select pg_try_advisory_lock(1)",
  "select pg_notify('c', 'x')",
  "select txid_current()",
  "explain analyze select 1",
  "explain (analyze) select 1",
  "explain insert into t values (1)",
  "lock table t",
  "set statement_timeout = 0",
  "show x; delete from t",
  "select 1; select 2",
  "begin",
  "values (1)",
  "table teachers",
  "create table t (id int)",
  "copy t to stdout",
  "call p()",
  "do $$ begin end $$",
  "select $$delete$$",
  "select $tag$x$tag$",
  "select E'a\\' ; delete from t; --'",
  "select 'unterminated",
  'select "unterminated',
  "select /* unterminated",
  "",
  "   ;  ",
  "refresh materialized view v",
  "vacuum t",
];

describe("isPlainReadSql", () => {
  for (const sql of reads) {
    it(`read: ${JSON.stringify(sql)}`, () => assert.equal(isPlainReadSql(sql), true));
  }
  for (const sql of writes) {
    it(`write: ${JSON.stringify(sql)}`, () => assert.equal(isPlainReadSql(sql), false));
  }
  it("a non-string is not a read", () => {
    assert.equal(isPlainReadSql(undefined as unknown as string), false);
  });
});

describe("isReadRequestBody", () => {
  const one = (query: string) => JSON.stringify({ query, params: [] });
  const batch = (...queries: string[]) => JSON.stringify({ queries: queries.map((query) => ({ query, params: [] })) });

  it("a single read query, and a batch of only reads", () => {
    assert.equal(isReadRequestBody(one("select 1")), true);
    assert.equal(isReadRequestBody(batch("select 1", "select 2")), true);
  });

  it("a batch with any write is a write", () => {
    assert.equal(isReadRequestBody(batch("select 1", "insert into t values (1)")), false);
    assert.equal(isReadRequestBody(batch("select pg_advisory_xact_lock(1, 2)", "select 1")), false);
  });

  it("the app's own statements: the allowance read is a read, the create batch a write", () => {
    const allowance = allowanceFor("free");
    const read = allowanceStatement("00000000-0000-0000-0000-000000000001", allowance);
    assert.equal(isReadRequestBody(JSON.stringify({ query: read.text, params: read.params })), true);
    const create = createSelfReadingStatements(
      "00000000-0000-0000-0000-000000000001",
      { title: "t", bodyText: "b", sourceUrl: null, gradeLevel: "5", questionCount: 3 },
      allowance,
    );
    assert.equal(isReadRequestBody(JSON.stringify({ queries: create.map((s) => ({ query: s.text, params: s.params })) })), false);
  });

  it("anything unexpected is a write", () => {
    for (const body of [undefined, null, 42, "", "not json", "null", "[]", "{}", JSON.stringify({ queries: [] }), JSON.stringify({ query: 1 }), JSON.stringify({ queries: [null] })]) {
      assert.equal(isReadRequestBody(body), false, String(body));
    }
    assert.equal(isReadRequestBody(new Blob([one("select 1")])), false);
  });
});

// A fetch that never answers (a stalled Neon request), but honours abort.
function neverAnswers(): { fetch: FetchLike; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  return {
    calls,
    fetch: (_input, init) => {
      calls.push(init ?? {});
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    },
  };
}

// Settles within `ms`, or "pending".
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; error: unknown } | "pending"> {
  return Promise.race([
    promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error })),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms)),
  ]);
}

const readBody = JSON.stringify({ query: "select 1", params: [] });
const writeBody = JSON.stringify({ query: "insert into t values (1)", params: [] });

describe("withReadTimeout", () => {
  it("is 15 seconds", () => assert.equal(DB_READ_TIMEOUT_MS, 15_000));

  it("a read that never answers rejects with DbReadTimeoutError at the timeout, and is aborted", async () => {
    const fake = neverAnswers();
    const started = Date.now();
    const outcome = await settleWithin(withReadTimeout(fake.fetch, 50)("https://x/sql", { method: "POST", body: readBody }), 1_000);
    assert.notEqual(outcome, "pending");
    assert.ok(outcome !== "pending" && !outcome.ok && outcome.error instanceof DbReadTimeoutError);
    assert.ok(Date.now() - started >= 45);
    assert.equal(fake.calls[0].signal?.aborted, true);
  });

  it("a read times out even when the fetch ignores the abort", async () => {
    const deaf: FetchLike = () => new Promise<Response>(() => {});
    const outcome = await settleWithin(withReadTimeout(deaf, 50)("https://x/sql", { method: "POST", body: readBody }), 1_000);
    assert.ok(outcome !== "pending" && !outcome.ok && isDbReadTimeout(outcome.error));
  });

  it("a write that never answers keeps waiting, with no signal added", async () => {
    const fake = neverAnswers();
    const outcome = await settleWithin(withReadTimeout(fake.fetch, 50)("https://x/sql", { method: "POST", body: writeBody }), 300);
    assert.equal(outcome, "pending");
    assert.equal(fake.calls[0].signal, undefined);
  });

  it("a fast read passes its response through", async () => {
    const ok: FetchLike = async () => new Response("{}", { status: 200 });
    const response = await withReadTimeout(ok, 1_000)("https://x/sql", { method: "POST", body: readBody });
    assert.equal(response.status, 200);
  });

  it("the caller's own abort still aborts a read", async () => {
    const fake = neverAnswers();
    const caller = new AbortController();
    const call = withReadTimeout(fake.fetch, 10_000)("https://x/sql", { method: "POST", body: readBody, signal: caller.signal });
    caller.abort(new Error("caller"));
    const outcome = await settleWithin(call, 500);
    assert.ok(outcome !== "pending" && !outcome.ok && (outcome.error as Error).message === "caller");
  });

  it("installing twice doesn't stack", () => {
    const once = readTimeoutFetchFunction(undefined);
    assert.equal(readTimeoutFetchFunction(once), once);
  });

  it("through the real driver: a stalled read rejects with an error isDbReadTimeout knows, a stalled write keeps waiting", async () => {
    const previous = neonConfig.fetchFunction;
    const fake = neverAnswers();
    neonConfig.fetchFunction = readTimeoutFetchFunction(fake.fetch, 50);
    try {
      const sql = neon("postgresql://user:password@db.example.invalid/unpack");
      const read = await settleWithin(sql.query("select 1"), 1_000);
      assert.ok(read !== "pending" && !read.ok && isDbReadTimeout(read.error), "as a read timeout (wrapped by the driver)");
      const write = await settleWithin(sql.query("insert into t values (1)"), 300);
      assert.equal(write, "pending");
      const batch = await settleWithin(sql.transaction([sql.query("select 1"), sql.query("delete from t")]), 300);
      assert.equal(batch, "pending");
    } finally {
      neonConfig.fetchFunction = previous;
    }
  });
});

describe("isDbReadTimeout", () => {
  it("finds the error through the driver's sourceError and a cause", () => {
    const inner = new DbReadTimeoutError(1);
    assert.equal(isDbReadTimeout(inner), true);
    assert.equal(isDbReadTimeout(Object.assign(new Error("Error connecting to database"), { sourceError: inner })), true);
    assert.equal(isDbReadTimeout(new Error("query failed", { cause: Object.assign(new Error("x"), { sourceError: inner }) })), true);
    assert.equal(isDbReadTimeout(new Error("fetch failed")), false);
    assert.equal(isDbReadTimeout(null), false);
    assert.equal(isDbReadTimeout("DbReadTimeoutError"), false);
  });
});
