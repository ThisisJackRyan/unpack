import assert from "node:assert/strict";
import { Console } from "node:console";
import { after, describe, it } from "node:test";
import { Writable } from "node:stream";
import { format } from "node:util";
import { runInNewContext } from "node:vm";
import { neon, neonConfig } from "@neondatabase/serverless";
import { DrizzleQueryError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import * as nextLog from "next/dist/build/output/log.js";
import { students } from "@/db/schema";
import { JoinCodeExhaustedError } from "./join-code";
import { hashSessionToken } from "./student-session-token";
import {
  CONSOLE_METHODS,
  errorLogFields,
  installSafeConsole,
  isErrorLike,
  looksLikeErrorDump,
  REDACTED_TEXT,
  sanitizeLogArg,
  sanitizeLogArgs,
} from "./safe-console";
import { safeErrorFields } from "./safe-error-fields";

// Obviously fake values, never real people.
const CLERK_ID = "user_2FAKECLERKID123";
const TOKEN = "FAKE-session-token-for-tests";
const TOKEN_HASH = hashSessionToken(TOKEN);
const DETAIL = "FAKE-DETAIL-MARKER";
const HINT = "FAKE-HINT-MARKER";
const WHERE = "FAKE-WHERE-MARKER";
const FORBIDDEN = [CLERK_ID, TOKEN, TOKEN_HASH, DETAIL, HINT, WHERE, "Failed query", "params:", "detail:", "hint:", "where:", "select"];

function assertClean(text: string) {
  for (const value of FORBIDDEN) assert.ok(!text.includes(value), `${value} in:\n${text}`);
}

// A real Node Console over a buffer, so the output is formatted exactly as
// the server's stderr would be.
function capturingConsole(): { target: Console; output: () => string } {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, done) {
      text += String(chunk);
      done();
    },
  });
  return { target: new Console({ stdout: stream, stderr: stream }), output: () => text };
}

// A real drizzle select by session hash, failing in Postgres with a Neon
// reply carrying detail, hint, and where, as the reviewer's repro did.
const realFetch = neonConfig.fetchFunction;
after(() => {
  neonConfig.fetchFunction = realFetch;
});
const db = drizzle(neon("postgresql://fake:fake@db.invalid/fake"));
async function failedSessionLookup(): Promise<DrizzleQueryError & { digest?: string }> {
  neonConfig.fetchFunction = async () =>
    new Response(
      JSON.stringify({
        message: `relation lookup failed for "${CLERK_ID}"`,
        code: "57P01",
        detail: DETAIL,
        hint: HINT,
        where: WHERE,
        severity: "FATAL",
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  try {
    await db.select().from(students).where(eq(students.sessionTokenHash, TOKEN_HASH)).limit(1);
  } catch (error) {
    assert.ok(error instanceof DrizzleQueryError);
    return error;
  }
  assert.fail("expected the query to fail");
}

describe("sanitizeLogArgs", () => {
  it("replaces an Error with its safe fields", () => {
    const error = Object.assign(new Error(`no row for ${CLERK_ID}`), { code: "23505" });
    assert.deepEqual(sanitizeLogArgs(["save failed", error]), ["save failed", { name: "Error", code: "23505", causes: [], timedOut: false }]);
  });

  it("keeps a digest that is a plain token, drops one with a path", () => {
    const error = Object.assign(new Error(CLERK_ID), { digest: "2753368539" });
    assert.deepEqual(sanitizeLogArg(error), { name: "Error", causes: [], timedOut: false, digest: "2753368539" });
    assert.equal(errorLogFields(Object.assign(new Error("x"), { digest: "2753368539@E394" })).digest, "2753368539@E394");
    assert.equal(errorLogFields(Object.assign(new Error("x"), { digest: 42 })).digest, 42);
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;/c/r/${CLERK_ID};307;` });
    assert.equal("digest" in errorLogFields(redirect), false);
    assert.equal("digest" in errorLogFields(Object.assign(new Error("x"), { digest: { id: CLERK_ID } })), false);
  });

  it("replaces Errors nested in objects and arrays, and keeps the rest", () => {
    const error = new Error(CLERK_ID, { cause: Object.assign(new Error(DETAIL), { code: "ETIMEDOUT" }) });
    const out = sanitizeLogArg({ readingId: "r1", attempts: [1, { error }], deep: { a: { b: { error } } } });
    const fields = { name: "Error", causes: [{ name: "Error", code: "ETIMEDOUT" }], timedOut: true };
    assert.deepEqual(out, { readingId: "r1", attempts: [1, { error: fields }], deep: { a: { b: { error: fields } } } });
    assertClean(format(out));
  });

  it("is cycle safe, and the cycle points at the sanitized copy", () => {
    const value: Record<string, unknown> = { error: new Error(CLERK_ID) };
    value.self = value;
    const out = sanitizeLogArg(value) as Record<string, unknown>;
    assert.equal(out.self, out);
    assert.deepEqual(out.error, { name: "Error", causes: [], timedOut: false });
    assertClean(format(out));
    const list: unknown[] = [new Error(CLERK_ID)];
    list.push(list);
    assertClean(format(sanitizeLogArg(list)));
  });

  it("treats error-like objects as errors: a stack, a name and a message, another realm", () => {
    const withStack = { stack: `Error: ${CLERK_ID}\n    at x (file.js:1:2)`, detail: DETAIL };
    const named = { name: "NeonDbError", message: `bad value ${CLERK_ID}`, hint: HINT };
    class LibraryFailure {
      name = "LibraryFailure";
      message = CLERK_ID;
    }
    const foreign = runInNewContext(`new RangeError(${JSON.stringify(CLERK_ID)})`);
    for (const value of [withStack, named, new LibraryFailure(), foreign, new DOMException(CLERK_ID, "AbortError")]) {
      assert.equal(isErrorLike(value), true);
      const out = sanitizeLogArg(value) as Record<string, unknown>;
      assert.equal("message" in out, false);
      assertClean(format(out));
    }
    assert.equal((sanitizeLogArg(foreign) as { name: string }).name, "RangeError");
  });

  it("passes other arguments through untouched", () => {
    const fields = { readingId: "r1", ms: 12, words: ["a", "b"], nested: { ok: true } };
    const date = new Date(0);
    const map = new Map([["k", "v"]]);
    const args = ["createReading: insertReading failed", fields, 3, null, undefined, true, date, map];
    const out = sanitizeLogArgs(args);
    assert.deepEqual(out, args);
    out.forEach((value, i) => assert.equal(value, args[i]));
  });

  it("passes safeErrorFields output through as is, fixed message included", () => {
    const fields = { ...safeErrorFields(new JoinCodeExhaustedError()), classId: "c1" };
    assert.equal(sanitizeLogArg(fields), fields);
    const wrapped = { localError: { ...safeErrorFields(new Error(CLERK_ID)), status: 500 } };
    assert.equal(sanitizeLogArg(wrapped), wrapped);
  });

  it("redacts strings that look like an error dump, not normal log text", () => {
    const dumps = [
      `Failed query: select "students"."id" from "students" where "students"."session_token_hash" = $1\nparams: ${TOKEN_HASH},1`,
      `oops\n  detail: '${DETAIL}',\n  hint: '${HINT}'`,
      `NeonDbError: bad value ${CLERK_ID}`,
      `Error: ${CLERK_ID}\n    at Object.<anonymous> (/srv/app.js:10:5)`,
      `  [cause]: NeonDbError: ${CLERK_ID}`,
    ];
    for (const text of dumps) {
      assert.equal(looksLikeErrorDump(text), true, text);
      assert.equal(sanitizeLogArg(text), REDACTED_TEXT);
      assert.deepEqual(sanitizeLogArg({ text }), { text: REDACTED_TEXT });
    }
    for (const text of [
      "createReading: recordLinkFetch failed",
      "questions.generate",
      "AI Gateway is out of credits (402). Question writing and the effort check fail until credits are added.",
      "▲ Next.js 16.2.11",
      "Where is the class code?",
      "%s took %dms",
    ]) {
      assert.equal(looksLikeErrorDump(text), false, text);
      assert.equal(sanitizeLogArg(text), text);
    }
  });

  it("a real DrizzleQueryError never leaks its SQL, params, or Neon detail", async () => {
    const error = await failedSessionLookup();
    // The error really carries them (so the test means something).
    assert.ok(error.message.includes(TOKEN_HASH) && error.message.startsWith("Failed query:"));
    assert.ok(format(error).includes(DETAIL));
    error.digest = "2753368539";

    const { target, output } = capturingConsole();
    installSafeConsole(target);
    target.error(error);
    target.error("⨯", error);
    target.error("%s", error);
    target.error(`wrapped: ${format(error)}`);
    target.warn({ error, sessionHash: "kept: not an error" });
    target.log([error]);
    target.info("x", error);
    target.debug(error);
    target.trace(error);
    target.dir(error);
    target.assert(false, error);
    const text = output();
    assertClean(text);
    assert.match(text, /DrizzleQueryError/);
    assert.match(text, /NeonDbError/);
    assert.match(text, /57P01/);
    assert.match(text, /2753368539/);
  });
});

describe("installSafeConsole", () => {
  it("wraps each method once, however often it is called", () => {
    const { target } = capturingConsole();
    const before = CONSOLE_METHODS.map((m) => target[m]);
    assert.equal(installSafeConsole(target), true);
    const wrapped = CONSOLE_METHODS.map((m) => target[m]);
    wrapped.forEach((fn, i) => assert.notEqual(fn, before[i]));
    assert.equal(installSafeConsole(target), false);
    CONSOLE_METHODS.forEach((m, i) => assert.equal(target[m], wrapped[i]));
  });

  it("works on a detached method", () => {
    const { target, output } = capturingConsole();
    installSafeConsole(target);
    const { error } = target;
    error(new Error(CLERK_ID));
    assertClean(output());
    assert.match(output(), /name: 'Error'/);
  });

  it("covers Next's own logger (log.error, as in base-server logError and router-server)", async () => {
    const error = await failedSessionLookup();
    const lines: string[] = [];
    const saved = { error: console.error, warn: console.warn, log: console.log };
    // A stand-in for the real stderr writer, then the wrapper on top, as
    // register() leaves the global console.
    console.error = (...args: unknown[]) => lines.push(format(...args));
    console.warn = (...args: unknown[]) => lines.push(format(...args));
    console.log = (...args: unknown[]) => lines.push(format(...args));
    try {
      installSafeConsole(console);
      nextLog.error(error);
      nextLog.error("unhandledRejection: ", error);
      nextLog.warn(error);
    } finally {
      Object.assign(console, saved);
    }
    const text = lines.join("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /⨯/);
    assert.match(text, /DrizzleQueryError/);
    assertClean(text);
  });
});
