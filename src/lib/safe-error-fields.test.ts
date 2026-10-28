import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { after, describe, it } from "node:test";
import { neon, neonConfig, NeonDbError } from "@neondatabase/serverless";
import { DrizzleQueryError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { readings, teachers } from "@/db/schema";
import { ClerkUserNoEmailError } from "./clerk-user-errors";
import { DeadlineError } from "./deadline";
import { FetchArticleError } from "./fetch-errors";
import { JoinCodeExhaustedError } from "./join-code";
import { resolveReadingSource } from "./reading-source";
import { MAX_CAUSES, safeErrorFields } from "./safe-error-fields";
import { deleteUnder13Account } from "./under-13-account";
import type { ReadingFormData } from "./validate-reading";

// Obviously fake values, never real people or readings.
const CLERK_ID = "user_2FAKECLERKID123";
const READING_TEXT = "FAKE READING TEXT about volcanoes";
const FORBIDDEN = [CLERK_ID, READING_TEXT, "Failed query", "select", "insert", "params"];

// Every query goes to this instead of the network: Neon's HTTP endpoint
// replying with a Postgres error that echoes the input, as the real one does.
const realFetch = neonConfig.fetchFunction;
after(() => {
  neonConfig.fetchFunction = realFetch;
});

function pgReply(body: Record<string, unknown>) {
  neonConfig.fetchFunction = async () =>
    new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/json" } });
}

const db = drizzle(neon("postgresql://fake:fake@db.invalid/fake"));

async function caught(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  assert.fail("expected the query to fail");
}

// A real drizzle select by Clerk id, failing in Postgres.
async function failedSelect(): Promise<unknown> {
  pgReply({ message: `invalid input syntax for type uuid: "${CLERK_ID}"`, code: "22P02", severity: "ERROR" });
  return caught(() => db.select().from(teachers).where(eq(teachers.clerkUserId, CLERK_ID)));
}

// A real drizzle insert of reading text, failing in Postgres.
async function failedInsert(): Promise<unknown> {
  pgReply({
    message: "insert or update on table \"readings\" violates foreign key constraint",
    code: "23503",
    detail: `Failing row contains (${READING_TEXT}).`,
    constraint: "readings_class_id_classes_id_fk",
  });
  return caught(() =>
    db.insert(readings).values({ classId: "00000000-0000-4000-8000-000000000000", title: "FAKE TITLE", bodyText: READING_TEXT }),
  );
}

function assertSafe(fields: unknown) {
  const json = JSON.stringify(fields);
  for (const value of FORBIDDEN) assert.ok(!json.includes(value), `${value} in ${json}`);
}

describe("safeErrorFields on real drizzle query errors", () => {
  it("a failed select by Clerk id keeps the names and the code, never the SQL or params", async () => {
    const error = await failedSelect();
    // The error really carries the SQL and the id (so the test means something).
    assert.ok(error instanceof DrizzleQueryError);
    assert.match(error.message, /^Failed query: select /);
    assert.ok(error.message.includes(`params: ${CLERK_ID}`));
    assert.ok(error.cause instanceof NeonDbError && error.cause.message.includes(CLERK_ID));

    const fields = safeErrorFields(error);
    assert.deepEqual(fields, { name: "DrizzleQueryError", causes: [{ name: "NeonDbError", code: "22P02" }], timedOut: false });
    assertSafe(fields);
  });

  it("a failed insert of reading text keeps the names and the code, never the text", async () => {
    const error = await failedInsert();
    assert.ok(error instanceof DrizzleQueryError);
    assert.match(error.message, /^Failed query: insert into "readings"/);
    assert.ok(error.message.includes(READING_TEXT));
    assert.ok((error.cause as { detail?: string }).detail?.includes(READING_TEXT));

    const fields = safeErrorFields(error);
    assert.deepEqual(fields, { name: "DrizzleQueryError", causes: [{ name: "NeonDbError", code: "23503" }], timedOut: false });
    assertSafe(fields);
  });

  it("a Neon connect timeout (fetch threw) is timedOut, through sourceError", async () => {
    neonConfig.fetchFunction = async () => {
      throw Object.assign(new Error(`connect ETIMEDOUT for ${CLERK_ID}`), { code: "ETIMEDOUT" });
    };
    const error = await caught(() => db.select().from(teachers).where(eq(teachers.clerkUserId, CLERK_ID)));
    assert.ok(error instanceof DrizzleQueryError);
    const fields = safeErrorFields(error);
    assert.deepEqual(fields, {
      name: "DrizzleQueryError",
      causes: [{ name: "NeonDbError" }, { name: "Error", code: "ETIMEDOUT" }],
      timedOut: true,
    });
    assertSafe(fields);
  });
});

describe("safeErrorFields cause chain", () => {
  it("names and codes every level, nearest first", () => {
    const pg = Object.assign(new Error(`duplicate key ${CLERK_ID}`), { name: "NeonDbError", code: "23505", detail: CLERK_ID });
    const wrapper = new Error("wrapped", { cause: new Error("middle", { cause: pg }) });
    assert.deepEqual(safeErrorFields(wrapper), {
      name: "Error",
      causes: [{ name: "Error" }, { name: "NeonDbError", code: "23505" }],
      timedOut: false,
    });
  });

  it("stops after MAX_CAUSES levels", () => {
    let error = new Error("bottom");
    for (let i = 0; i < 20; i++) error = new Error(`level ${i}`, { cause: error });
    assert.equal(safeErrorFields(error).causes.length, MAX_CAUSES);
  });

  it("doesn't loop on a cycle", () => {
    const a = new Error("a");
    const b = Object.assign(new Error("b"), { code: "B1" });
    a.cause = b;
    b.cause = a;
    assert.deepEqual(safeErrorFields(a), { name: "Error", causes: [{ name: "Error", code: "B1" }], timedOut: false });
    const self = new Error("self");
    self.cause = self;
    assert.deepEqual(safeErrorFields(self).causes, []);
  });

  it("keeps only short identifier-like names and codes", () => {
    const odd = Object.assign(new Error("x"), { name: `name ${CLERK_ID} with spaces`, code: `code: ${READING_TEXT}` });
    assert.deepEqual(safeErrorFields(odd), { name: "Error", causes: [], timedOut: false });
    const objectCode = Object.assign(new Error("x"), { code: { text: READING_TEXT } });
    assert.deepEqual(safeErrorFields(objectCode), { name: "Error", causes: [], timedOut: false });
    assert.deepEqual(safeErrorFields(Object.assign(new Error("x"), { code: 42 })).code, 42);
  });

  it("keeps only uppercase codes and integers, dropping id-shaped and mixed-case values", () => {
    for (const code of ["23505", "57P01", "22P02", "ETIMEDOUT", "ECONNREFUSED", "UND_ERR_SOCKET", 404, 0]) {
      assert.equal(safeErrorFields(Object.assign(new Error("x"), { code })).code, code);
    }
    for (const code of [CLERK_ID, "etimedout", "EConnRefused", "invalid_request", "E".repeat(41), 1.5, Number.NaN, Infinity]) {
      assert.equal("code" in safeErrorFields(Object.assign(new Error("x"), { code })), false, String(code));
    }
    const nested = new Error("x", { cause: Object.assign(new Error("y"), { code: CLERK_ID }) });
    assert.deepEqual(safeErrorFields(nested).causes, [{ name: "Error" }]);
  });

  it("names an Error from another realm, never its message", () => {
    const foreign = runInNewContext(`(() => { const e = new TypeError(${JSON.stringify(READING_TEXT)}); e.code = "ECONNRESET"; return e; })()`);
    assert.equal(foreign instanceof Error, false);
    assert.deepEqual(safeErrorFields(foreign), { name: "TypeError", code: "ECONNRESET", causes: [], timedOut: false });
  });

  it("names a DrizzleQueryError from another copy of drizzle (a minified class)", () => {
    const copy = class d extends Error {};
    const error = Object.assign(new copy(`Failed query: select 1\nparams: ${CLERK_ID}`), { query: "select 1", params: [CLERK_ID] });
    assert.deepEqual(safeErrorFields(error), { name: "DrizzleQueryError", causes: [], timedOut: false });
    class Rollback extends Error {}
    Object.defineProperty(Rollback, Symbol.for("drizzle:entityKind"), { value: "TransactionRollbackError" });
    assert.equal(safeErrorFields(new Rollback("Rollback")).name, "TransactionRollbackError");
  });

  it("uses the constructor's name when the name is the generic Error", () => {
    class SomeLibraryError extends Error {}
    assert.equal(safeErrorFields(new SomeLibraryError(READING_TEXT)).name, "SomeLibraryError");
  });
});

describe("safeErrorFields timedOut", () => {
  it("is true for an abort or a timeout, at the top or nested", () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    assert.equal(safeErrorFields(abort).timedOut, true);
    assert.equal(safeErrorFields(timeout).timedOut, true);
    assert.equal(safeErrorFields(Object.assign(new Error("x"), { name: "AbortError" })).timedOut, true);
    assert.equal(safeErrorFields(new Error("wrapped", { cause: new Error("again", { cause: timeout }) })).timedOut, true);
    assert.equal(safeErrorFields(new Error("fetch failed", { cause: Object.assign(new Error("x"), { code: "UND_ERR_HEADERS_TIMEOUT" }) })).timedOut, true);
    assert.equal(safeErrorFields(new DeadlineError()).timedOut, true);
    assert.equal(safeErrorFields(new FetchArticleError("timeout")).timedOut, true);
    assert.equal(safeErrorFields(Object.assign(new Error("x"), { code: "57014" })).timedOut, true);
  });

  it("is false otherwise", () => {
    assert.equal(safeErrorFields(new Error("boom")).timedOut, false);
    assert.equal(safeErrorFields(Object.assign(new Error("x"), { code: "23505" })).timedOut, false);
    assert.equal(safeErrorFields(new FetchArticleError("blocked")).timedOut, false);
    assert.equal(safeErrorFields("TimeoutError").timedOut, false);
    assert.equal(safeErrorFields({ name: "TimeoutError" }).timedOut, false);
  });
});

describe("safeErrorFields message", () => {
  it("is kept for the app's own fixed-message errors", () => {
    assert.equal(safeErrorFields(new JoinCodeExhaustedError()).message, "Could not generate a unique join code in 5 attempts");
    assert.equal(safeErrorFields(new DeadlineError()).message, "pre-check deadline passed");
    assert.equal(safeErrorFields(new FetchArticleError("not_html")).message, "fetch article failed: not_html");
    assert.equal(safeErrorFields(new ClerkUserNoEmailError()).message, "Clerk user has no email address");
  });

  it("is dropped for everything else", () => {
    const neonLike = Object.assign(new Error(`invalid input syntax for type uuid: "${CLERK_ID}"`), {
      name: "NeonDbError",
      code: "22P02",
    });
    for (const value of [
      new Error(READING_TEXT),
      neonLike,
      new NeonDbError(`connection string: postgresql://${CLERK_ID}@db.invalid`),
      // An own error is only allowed at the top, not as a cause.
      new Error(READING_TEXT, { cause: new JoinCodeExhaustedError() }),
      READING_TEXT,
      { message: READING_TEXT, name: CLERK_ID },
      null,
      undefined,
    ]) {
      const fields = safeErrorFields(value);
      assert.equal("message" in fields, false);
      assertSafe(fields);
    }
    assert.deepEqual(safeErrorFields(READING_TEXT), { name: "string", causes: [], timedOut: false });
    assert.deepEqual(safeErrorFields({ message: READING_TEXT, name: CLERK_ID }), { name: "object", causes: [], timedOut: false });
  });
});

describe("call sites log only safe fields", () => {
  const LINK: ReadingFormData = {
    gradeLevel: "4",
    questionCount: 3,
    questionMode: "shared",
    source: "link",
    url: "https://example.com/story",
    title: "",
  };

  it("resolveReadingSource (createReading, createSelfReadingAction): a failed limit query", async () => {
    const logs: [string, Record<string, unknown>][] = [];
    const error = await failedSelect();
    await resolveReadingSource(LINK, {
      recordLinkFetch: async () => {
        throw error;
      },
      fetchArticle: async () => assert.fail("no fetch when the limit can't be checked"),
      log: (message, fields) => logs.push([message, fields]),
    });
    assert.deepEqual(logs, [
      ["recordLinkFetch failed", { name: "DrizzleQueryError", causes: [{ name: "NeonDbError", code: "22P02" }], timedOut: false }],
    ]);
    assertSafe(logs);
  });

  it("deleteUnder13Account: a failed local delete", async () => {
    const logs: Record<string, unknown>[] = [];
    const error = await failedInsert();
    await deleteUnder13Account(CLERK_ID, {
      deleteLocal: async () => {
        throw error;
      },
      deleteClerkUser: async () => {},
      confirmClerkDeleted: async () => {},
      log: (_level, _message, fields) => logs.push(fields),
    });
    assert.deepEqual(logs[0].localError, {
      name: "DrizzleQueryError",
      causes: [{ name: "NeonDbError", code: "23503" }],
      timedOut: false,
      status: undefined,
    });
    assertSafe(logs);
  });
});
