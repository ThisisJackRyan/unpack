import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { neon, neonConfig } from "@neondatabase/serverless";
import { eq } from "drizzle-orm";
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
  "select 'insert into x; delete from y' as text",
  "select 'it''s' as a, \"update\" from \"delete\"",
  "select 1 -- for update\n",
  "select /* insert */ 1",
  "select /* nested /* delete */ comment */ 1",
  "select now() - make_interval(days => $2::int)",
  "select r.id from readings r where r.slot_released_at is null and r.created_at > now()",
  "select exists (select 1 from classes where id = $1)",
  'select "set", "updated_at" from "t" where "t"."note" = \'delete from t\'',
  "select count(*), count (*), coalesce(min(created_at), now()), max(id) from t",
  "select greatest(a, b), lower(name), bool_or(x) filter (where y) from t",
  "select json_agg(json_build_object('a', a)) from t",
  "select * from t where id in (select id from u) and not exists (select 1) or x = any ($1)",
  "select * from a left join lateral (select 1) l on true",
  "select count /* c */ (*) from t",
  "with x(a, b) as (select 1, 2) select * from x",
  "with x as materialized (select 1) select * from x",
];

// Not reads: writes, and anything not clearly a plain read.
const notReads = [
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
  "show timezone",
  "explain select * from readings",
  // Functions off the allow-list.
  'select "pg_advisory_lock"(1)',
  'select "pg_advisory_lock" (1)',
  'select "pg_advisory_lock"\n(1)',
  'select "pg_advisory_lock"/* c */(1)',
  'select "pg_advisory_lock"-- c\n(1)',
  'select "pg_catalog"."pg_advisory_lock"(1)',
  "select pg_advisory_lock(1)",
  "select pg_try_advisory_lock(1)",
  "select pg_catalog.pg_advisory_lock(1)",
  "select pg_catalog . count(1)",
  "select pg_catalog.count(*) from t",
  "select foo.bar(1)",
  "select pg_sleep(20)",
  "select pg_sleep /* c */ (20)",
  "select * from pg_sleep(20)",
  "select set_config('a','b',false)",
  "select nextval('s')",
  "select setval('s',1)",
  "select pg_notify('c','x')",
  "select pg_terminate_backend(1)",
  "select dblink('x')",
  "select lo_import('x')",
  "select pg_stat_statements_reset()",
  "select query_to_xml('delete from t', true, true, '')",
  "select txid_current()",
  "select some_unknown_fn(1)",
  "select count(*) from t where x = some_unknown_fn(1)",
  "select $1::numeric(10, 2)",
  "select foo$bar(1)",
  "select f\u00e9(1)",
  "select U&'d\\0061t\\+000061'",
  'select U&"d\\0061t" from t',
  // Locking clauses, also split over lines.
  "select * from t for update",
  "select * from t for share",
  "select * from t for no key update",
  "select * from t for key share",
  "select * from t for\nupdate",
  "select * from t for\n  no key\n update",
  "select * from t for update nowait",
  // Data-modifying CTEs.
  "with d as (delete from t returning *) select * from d",
  "with i as (insert into t values (1) returning id) select id from i",
  // Unparsed.
  "select 1; delete from t",
  "select $$x$$",
  "select E'x'",
  "select 'x",
  "select 1 /* x",
];

describe("isPlainReadSql", () => {
  for (const sql of reads) {
    it(`read: ${JSON.stringify(sql)}`, () => assert.equal(isPlainReadSql(sql), true));
  }
  for (const sql of notReads) {
    it(`not a read: ${JSON.stringify(sql)}`, () => assert.equal(isPlainReadSql(sql), false));
  }
  it("a non-string is not a read", () => {
    assert.equal(isPlainReadSql(undefined as unknown as string), false);
  });
});

describe("isPlainReadSql: a -- comment ends at \\n or \\r", () => {
  const cases: [string, boolean][] = [
    ["select 1 --x\r, pg_advisory_lock(1)", false],
    ["select 1 --x\r\n, pg_advisory_lock(1)", false],
    ["with --x\r d as (delete from t returning 1) select 1", false],
    ["with --x\r\n d as (delete from t returning 1) select 1", false],
    ["select 1 --x\r; select pg_sleep(1)", false],
    ["select 1 --x\r\n; select pg_sleep(1)", false],
    ["select 1 --x\r\n", true],
    ["select 1 --x\r", true],
    ["select a --comment\r\nfrom t", true],
    ["select a --comment\rfrom t", true],
    ["select 1 -- trailing", true],
  ];
  for (const [sql, expected] of cases) {
    it(`${expected ? "read" : "not a read"}: ${JSON.stringify(sql)}`, () => assert.equal(isPlainReadSql(sql), expected));
  }
});

describe("isPlainReadSql: a column list counts only for a CTE in a WITH list, or after as", () => {
  const cases: [string, boolean][] = [
    // A function's column definition list: the call is still a call.
    ["select * from dblink('host=x', 'delete from t returning 1') as (n int)", false],
    ["select * from dblink('host=x', 'delete from t returning 1') as t(n int)", false],
    ["select * from t, dblink('a','b') as (n int)", false],
    ["select * from t join dblink('a','b') as (n int) on true", false],
    ["select dblink('a','b') as (n int)", false],
    ["select 1, dblink('a','b') as (n int)", false],
    ["select * from (select * from dblink('a','b') as (n int)) s", false],
    ["with d as (select 1) select * from dblink('a','b') as (n int)", false],
    ["with d(x) as (select 1) select * from dblink('a','b') as (n int)", false],
    ["with d as (select 1), e as (select 2) select * from d, dblink('a','b') as (n int)", false],
    ["with d as (select dblink('a','b') as (n int)) select 1", false],
    ["with d as materialized (select 1) select * from dblink('a','b') as materialized (n int)", false],
    // CTE column lists, and an alias's.
    ["with t(n) as (select 1) select n from t", true],
    ["with recursive t(n) as (select 1 union all select n + 1 from t where n < 3) select n from t", true],
    ["with a(x) as (select 1), b(y) as (select x from a) select y from b", true],
    ["with a as (select 1), b(y) as (select 2) select y from b", true],
    ["with t(n) as materialized (select 1) select n from t", true],
    ["with t(n) as not materialized (select 1) select n from t", true],
    ["select * from (with t(n) as (select 1) select n from t) s", true],
    ['with "t"(n) as (select 1) select n from "t"', true],
    ["select * from t as p(a, b)", true],
  ];
  for (const [sql, expected] of cases) {
    it(`${expected ? "read" : "not a read"}: ${JSON.stringify(sql)}`, () => assert.equal(isPlainReadSql(sql), expected));
  }
});

// The SQL the app really sends: its own query functions, run on the real
// driver (src/db/index.ts) with a fetch that records each request body and
// answers with no rows, so no database is needed. Each case lists the
// classification of every request it sends, in order.
describe("the app's own queries", () => {
  const U = "00000000-0000-4000-8000-000000000001";
  const bodies: string[] = [];
  let previousFetch: typeof neonConfig.fetchFunction;
  let previousUrl: string | undefined;

  before(() => {
    previousFetch = neonConfig.fetchFunction;
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://user:password@db.example.invalid/unpack";
    neonConfig.fetchFunction = async (_input: unknown, init?: RequestInit) => {
      const body = String(init?.body);
      bodies.push(body);
      const empty = { fields: [], rows: [], command: "SELECT", rowCount: 0, rowAsArray: false };
      const parsed = JSON.parse(body) as { queries?: unknown[] };
      const reply = parsed.queries ? { results: parsed.queries.map(() => empty) } : empty;
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    };
  });
  after(() => {
    neonConfig.fetchFunction = previousFetch;
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  });

  const READ = "read";
  const WRITE = "write";
  type Kind = typeof READ | typeof WRITE;

  async function sent(run: () => Promise<unknown> | undefined): Promise<{ kinds: Kind[]; sql: string[] }> {
    bodies.length = 0;
    await run();
    const sql = bodies.flatMap((b) => {
      const parsed = JSON.parse(b) as { query?: string; queries?: { query: string }[] };
      return parsed.queries ? parsed.queries.map((q) => q.query) : [String(parsed.query)];
    });
    return { kinds: bodies.map((b) => (isReadRequestBody(b) ? READ : WRITE)), sql };
  }

  const cases: [string, Kind[], () => Promise<unknown> | undefined][] = [];
  const read = (name: string, run: () => Promise<unknown> | undefined, kinds: Kind[] = [READ]) => cases.push([name, kinds, run]);
  const write = (name: string, run: () => Promise<unknown> | undefined) => cases.push([name, [WRITE], run]);

  const lib = async () => ({
    db: await import("@/db"),
    classes: await import("@/lib/classes"),
    readings: await import("@/lib/readings"),
    shared: await import("@/lib/shared-questions-db"),
    lookup: await import("@/lib/student-lookup"),
    studentReadings: await import("@/lib/student-readings"),
    sets: await import("@/lib/student-sets-db"),
    queue: await import("@/lib/challenge-queue"),
    status: await import("@/lib/class-status-db"),
    progress: await import("@/lib/reading-progress-db"),
    answers: await import("@/lib/teacher-answers-db"),
    generations: await import("@/lib/question-generation-attempts"),
    linkFetches: await import("@/lib/link-fetch-attempts"),
    self: await import("@/lib/self-readings"),
    studentQuestions: await import("@/lib/student-questions"),
    submit: await import("@/lib/submit-answers-core"),
    selfAnswers: await import("@/lib/self-answers-core"),
    selfQuestions: await import("@/lib/self-questions-core"),
    challenges: await import("@/lib/challenges"),
    join: await import("@/lib/student-join"),
    executor: await import("@/lib/neon-executor"),
  });
  let m: Awaited<ReturnType<typeof lib>>;
  before(async () => {
    m = await lib();
  });
  const ref = { classId: U, readingId: U, teacherId: U };
  const fingerprint = { bodyMd5: "0".repeat(32), gradeLevel: "5" as const, questionCount: 3 };
  const studentStore = () => m.studentQuestions.postgresStudentQuestionStore();
  const attemptStore = () => m.submit.postgresAttemptStore(m.executor.neonExecutor);
  const selfAttemptStore = () => m.selfAnswers.postgresSelfAttemptStore(m.executor.neonExecutor);
  const selfQuestionStore = () => m.selfQuestions.postgresSelfQuestionStore(m.executor.neonExecutor);
  const save = { studentId: U, readingId: U, claimId: U, attemptId: U, passed: true, verdicts: [{ questionId: U, text: "t", pass: true, nudge: "" }] };

  // getOrCreateTeacher (account.ts, behind Clerk) looks the account up by
  // its Clerk id with this builder; the rest are the exported functions.
  read("getOrCreateTeacher's lookup", async () => {
    const { db, schema } = m.db;
    await db.select().from(schema.teachers).where(eq(schema.teachers.clerkUserId, "user_x")).limit(1);
  });
  // Teacher class and reading pages.
  read("listClasses", () => m.classes.listClasses(U));
  read("countClasses", () => m.classes.countClasses(U));
  read("getClassForTeacher", () => m.classes.getClassForTeacher(U, U));
  read("countDraftsClearedByGradeChange", () => m.classes.countDraftsClearedByGradeChange(U, U));
  read("listReadings", () => m.readings.listReadings(U, U));
  read("getReadingForTeacher", () => m.readings.getReadingForTeacher(U, U, U));
  read("getClassCapBadges", () => m.readings.getClassCapBadges(U, U));
  read("getReadingCap", () => m.readings.getReadingCap(U, U, U));
  read("listSharedQuestions", () => m.shared.listSharedQuestions(U));
  read("listStudentSets", () => m.sets.listStudentSets(U, U));
  read("loadTeacherQueue", () => m.queue.loadTeacherQueue(U, U));
  read("countTeacherQueue", () => m.queue.countTeacherQueue(U, U));
  read("loadChallengeQueue", () => m.queue.loadChallengeQueue(U, U));
  read("countOpenChallenges", () => m.queue.countOpenChallenges(U, U));
  read("loadClassStatus", () => m.status.loadClassStatus(U, U));
  read("loadTeacherAnswers", () => m.answers.loadTeacherAnswers(U, U, {}));
  // Limits and retry times.
  read("questionGenerationRetryAt", () => m.generations.questionGenerationRetryAt(U));
  read("linkFetchRetryAt", () => m.linkFetches.linkFetchRetryAt(U));
  read("getAllowance (the weekly count)", () => m.self.getAllowance(U));
  // Student reading pages.
  read("findStudentBySessionToken", () => m.lookup.findStudentBySessionToken("token"));
  read("getPublishedReading", () => m.studentReadings.getPublishedReading(U, U));
  read("loadReadingProgress", () => m.progress.loadReadingProgress(U, U));
  read("listReadingsWithStatus", () => m.progress.listReadingsWithStatus(U, U));
  // Question loads.
  read("student questions: loadContext", () => studentStore().loadContext(U, U));
  read("student questions: readQuestions", () => studentStore().readQuestions(U, U));
  read("student questions: throttledUntil", () => studentStore().throttledUntil?.(U, U));
  read("self questions: loadContext", () => selfQuestionStore().loadContext(U, U));
  read("self questions: readQuestions", () => selfQuestionStore().readQuestions(U, U));
  read("self questions: allowanceState", () => selfQuestionStore().allowanceState(U, m.self.currentAllowance()));
  read("self questions: rateLimitedUntil", () => selfQuestionStore().rateLimitedUntil?.(U));
  // Answer-check reads.
  read("answers: loadContext", () => attemptStore().loadContext(U, U));
  read("answers: pausedUntil", () => attemptStore().pausedUntil?.(U, U));
  read("self answers: loadContext", () => selfAttemptStore().loadContext(U, U));
  read("self answers: pausedUntil", () => selfAttemptStore().pausedUntil?.(U, U));
  // Self-learner pages.
  read("getSelfReading", () => m.self.getSelfReading(U, U));
  read("listSelfHistory", () => m.self.listSelfHistory(U, "UTC"));

  // Writes, and batches that start with one (loadSelfProgress settles a
  // stale check first).
  write("loadSelfProgress", () => m.self.loadSelfProgress(U, U));
  write("insertClassIfAllowed", () => m.classes.insertClassIfAllowed(U, { name: "c", gradeLevel: "5" }));
  write("updateClassSettings", () => m.classes.updateClassSettings(U, U, { name: "c", gradeLevel: "5" }));
  write("setJoinCodeActive", () => m.classes.setJoinCodeActive(U, U, false));
  write("deleteStudent", () => m.classes.deleteStudent(U, U, U));
  write("resetStudentQuestionCalls", () => m.classes.resetStudentQuestionCalls(U, U, U, U));
  write("insertReading", () => m.readings.insertReading(U, U, { title: "t", bodyText: "b", sourceUrl: null, bodyTrimmed: false, gradeLevel: "5", questionCount: 3, questionMode: "shared" }));
  write("saveReadingEdit", () => m.readings.saveReadingEdit(U, U, U, { title: "t", bodyText: "b", gradeLevel: "5", questionCount: 3, questionMode: "shared" }));
  write("deleteReading", () => m.readings.deleteReading(U, U, U));
  write("raiseReadingCap", () => m.readings.raiseReadingCap(U, U, U));
  write("saveQuestionSet", () => m.shared.saveQuestionSet(ref, fingerprint, ["q"], "generate"));
  write("updateSharedQuestion", () => m.shared.updateSharedQuestion(ref, U, "q"));
  write("deleteSharedQuestion", () => m.shared.deleteSharedQuestion(ref, U));
  write("publishReading", () => m.shared.publishReading(ref));
  write("decideChallenge", () => m.queue.decideChallenge({ challengeId: U, classId: U, teacherId: U, decision: "accept", extraTry: false }));
  write("grantExtraTry", () => m.queue.grantExtraTry({ classId: U, teacherId: U, studentId: U, readingId: U }));
  write("sendChallenge", () => m.challenges.sendChallenge(U, U, "note"));
  // With no rows back the join limit refuses, so the join then reads the
  // retry time.
  cases.push(["joinClass", [WRITE, READ], () => m.join.joinClass({ code: "ABC123", firstName: "A", lastInitials: "B" }, "hash")]);
  write("recordQuestionGeneration", () => m.generations.recordQuestionGeneration(U));
  write("recordLinkFetchAttempt", () => m.linkFetches.recordLinkFetchAttempt(U));
  write("createSelfReading", () => m.self.createSelfReading(U, { title: "t", bodyText: "b", sourceUrl: null, bodyTrimmed: false, gradeLevel: "5", questionCount: 3 }));
  write("student questions: claim", () => studentStore().claim(U, U, U, 3));
  write("student questions: takeOverStale", () => studentStore().takeOverStale(U, U, U, 60));
  write("student questions: release", () => studentStore().release(U, U, U, true));
  write("student questions: commit", () => studentStore().commit(U, U, U, ["q"]));
  write("self questions: claim", () => selfQuestionStore().claim(U, U, U, m.self.currentAllowance()));
  write("self questions: release", () => selfQuestionStore().release(U, U, U));
  write("self questions: commit", () => selfQuestionStore().commit(U, U, U, ["q"]));
  write("answers: claim", () => attemptStore().claim(U, U, U, 0));
  write("answers: release", () => attemptStore().release(U, U, U, true));
  write("answers: commit", () => attemptStore().commit(save));
  write("self answers: claim", () => selfAttemptStore().claim(U, U, U, 0));
  write("self answers: release", () => selfAttemptStore().release(U, U, U, true));
  write("self answers: commit", () => selfAttemptStore().commit(save));

  it("every case sends at least one request", async () => {
    for (const [name, , run] of cases) {
      const { kinds } = await sent(run);
      assert.ok(kinds.length > 0, name);
    }
  });

  it("each read path is a read, each write path a write", async () => {
    for (const [name, expected, run] of cases) {
      const { kinds, sql } = await sent(run);
      assert.deepEqual(kinds, expected, `${name}:\n${sql.join("\n---\n")}`);
    }
  });

  it("every statement of every read path is a plain read on its own", async () => {
    for (const [name, expected, run] of cases) {
      if (!expected.every((k) => k === READ)) continue;
      const { sql } = await sent(run);
      for (const q of sql) assert.equal(isPlainReadSql(q), true, `${name}: ${q}`);
    }
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
      { title: "t", bodyText: "b", sourceUrl: null, bodyTrimmed: false, gradeLevel: "5", questionCount: 3 },
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
