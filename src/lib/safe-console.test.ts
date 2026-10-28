import assert from "node:assert/strict";
import { Console } from "node:console";
import { after, describe, it } from "node:test";
import { Writable } from "node:stream";
import { format, inspect } from "node:util";
import { runInNewContext } from "node:vm";
import { neon, neonConfig } from "@neondatabase/serverless";
import { DrizzleQueryError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import * as nextLog from "next/dist/build/output/log.js";
import { students } from "@/db/schema";
import { DbReadTimeoutError } from "@/db/read-timeout";
import { ClerkUserNoEmailError } from "./clerk-user-errors";
import { DeadlineError } from "./deadline";
import { FetchArticleError } from "./fetch-errors";
import { JoinCodeExhaustedError } from "./join-code";
import { hashSessionToken } from "./student-session-token";
import {
  CONSOLE_METHODS,
  errorLogFields,
  installSafeConsole,
  isErrorLike,
  looksLikeErrorDump,
  MAX_DEPTH,
  REDACTED_PART,
  REDACTED_TEXT,
  redactLogText,
  sanitizeLogArg,
  sanitizeLogArgs,
} from "./safe-console";
import { FIXED_ERROR_MESSAGES, safeErrorFields } from "./safe-error-fields";

// Obviously fake values, never real people.
const CLERK_ID = "user_2FAKECLERKID123";
const LETTERS_CLERK_ID = "user_AbCdEfGhIjKlMnOpQrStUvWxYzA";
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
    const fields = { readingId: "0e3c1a2b-4d5e-4f60-8a7b-9c0d1e2f3a4b", ms: 12, words: ["a", "b"], nested: { ok: true } };
    const fn = function namedHelper() {};
    const args = ["createReading: insertReading failed", fields, 3, null, undefined, true, BigInt(10), fn];
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

  it("keeps harmless fixed text, and an Error line with an allow-listed message", () => {
    for (const text of [
      "Error: AI_GATEWAY_API_KEY is not set",
      "DeadlineError: pre-check deadline passed",
      "JoinCodeExhaustedError: Could not generate a unique join code in 5 attempts",
      "where: createReading",
      "  where: createReading",
      "createReading: insertReading failed",
      "join_blocked_config",
      "qa-create-action started run=self-network-ConnectionClosed-12",
      "readingId 0e3c1a2b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
      "digest 2753368539@E394",
      "next@16.2.11 ready",
      "AI Gateway is not set up: no AI_GATEWAY_API_KEY and no Vercel OIDC token (VERCEL_OIDC_TOKEN unset and not running on Vercel).",
    ]) {
      assert.equal(looksLikeErrorDump(text), false, text);
      assert.equal(redactLogText(text), text, text);
      assert.equal(sanitizeLogArg(text), text, text);
    }
  });

  it("redacts every Error line whose message isn't exactly an allow-listed one", () => {
    for (const text of [
      // Letters only, but a name and a title.
      "TypeError: Student Maya Ro joined The Very Hungry Caterpillar",
      "TypeError: Failed to fetch",
      "AbortError: This operation was aborted",
      // An allow-listed message with text after it.
      "Error: AI_GATEWAY_API_KEY is not set for maya@x.com",
      "Error: AI_GATEWAY_API_KEY is not set extra",
      "Error: AI_GATEWAY_API_KEY is not set.",
      // Or before it.
      "Error: Maya AI_GATEWAY_API_KEY is not set",
      "Error:  AI_GATEWAY_API_KEY is not set",
      "Error: ",
      // One fine line does not keep another.
      "Error: AI_GATEWAY_API_KEY is not set\nTypeError: Student Maya Ro",
    ]) {
      assert.equal(looksLikeErrorDump(text), true, text);
      assert.equal(sanitizeLogArg(text), REDACTED_TEXT, text);
    }
  });

  it("FIXED_ERROR_MESSAGES holds our own classes' messages exactly", () => {
    const own = [
      new DeadlineError(),
      new DbReadTimeoutError(1000),
      new JoinCodeExhaustedError(),
      new ClerkUserNoEmailError(),
      ...(["invalid_url", "blocked", "timeout", "too_large", "not_html", "http_error", "extract_failed", "too_long"] as const).map(
        (kind) => new FetchArticleError(kind),
      ),
    ];
    for (const error of own) {
      assert.ok(FIXED_ERROR_MESSAGES.has(error.message), error.message);
      assert.equal(redactLogText(String(error)), String(error));
    }
    assert.equal(FIXED_ERROR_MESSAGES.size, own.length + 1);
  });

  it("redacts a bare Postgres message that can echo row values", () => {
    for (const text of [
      'duplicate key value violates unique constraint "teachers_email_unique"',
      "Key (email)=(fake@example.invalid) already exists.",
      'invalid input syntax for type uuid: "FAKE-not-a-uuid"',
      'invalid input value for enum role: "FAKE"',
      "Failing row contains (FAKE, Ada, L).",
      'new row for relation "students" violates check constraint "students_name_check"',
      'null value in column "first_name" of relation "students" violates not-null constraint',
      "value too long for type character varying(40)",
      'value "99999999999" is out of range for type integer',
      'syntax error at or near "FAKE"',
      'password authentication failed for user "fake_user"',
      'relation "FAKE" does not exist',
      "where: 'SQL statement \"select 1\"'",
      "where: PL/pgSQL function fake() line 3 at RAISE",
      "DETAIL:  Key (email)=(fake@example.invalid) already exists.",
      "NeonDbError: FAKE row 42",
      'Error: invalid value "FAKE"',
      "Error: no row for id 12",
      "Error: fetch failed: https://fake.example.invalid/x",
      `Error: no user for ${LETTERS_CLERK_ID}`,
    ]) {
      assert.equal(looksLikeErrorDump(text), true, text);
      assert.equal(sanitizeLogArg(text), REDACTED_TEXT, text);
    }
  });

  it("replaces URLs, emails, IPs, ids, and secrets inside other text", () => {
    const cases: [string, string][] = [
      ["link https://fake.example.invalid/path?q=1 skipped", `link ${REDACTED_PART} skipped`],
      ["db postgresql://fake:fake@db.invalid/fake down", `db ${REDACTED_PART} down`],
      ["see www.fake-blog.invalid/me", `see ${REDACTED_PART}`],
      ["from fake.person@example.invalid today", `from ${REDACTED_PART} today`],
      ["ip 203.0.113.7 refused", `ip ${REDACTED_PART} refused`],
      [`clerk ${CLERK_ID} missing`, `clerk ${REDACTED_PART} missing`],
      // A Clerk id with no digit at all.
      [`lookup ${LETTERS_CLERK_ID}`, `lookup ${REDACTED_PART}`],
      ["session sess_FakeSessionIdLettersOnly done", `session ${REDACTED_PART} done`],
      [`hash ${TOKEN_HASH}`, `hash ${REDACTED_PART}`],
      ["auth Bearer abc.def.ghi", `auth ${REDACTED_PART}`],
      ["key sk_live_FAKE1234567890", `key ${REDACTED_PART}`],
      ["webhook whsec_FAKEFAKEFAKE", `webhook ${REDACTED_PART}`],
      ["jwt eyJhbGciOi.eyJzdWIiOi.c2ln", `jwt ${REDACTED_PART}`],
      ["password=hunter2 rejected", `${REDACTED_PART} rejected`],
      ["api_key: FAKEKEY", REDACTED_PART],
    ];
    for (const [text, expected] of cases) {
      assert.equal(looksLikeErrorDump(text), false, text);
      assert.equal(redactLogText(text), expected, text);
      assert.equal(sanitizeLogArg(text), expected, text);
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
    // eslint-disable-next-line unpack/no-raw-error-log -- a raw error through the wrapper, on purpose
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

describe("sanitizeLogArg: Map, Set, Date, and class instances", () => {
  it("logs a Map or Set as its class name and size, never its contents", () => {
    const map = new Map<string, unknown>([
      ["fake@example.invalid", { clerkId: CLERK_ID }],
      ["error", new Error(DETAIL)],
    ]);
    const set = new Set(["fake@example.invalid", CLERK_ID]);
    assert.deepEqual(sanitizeLogArg(map), { redacted: "Map", size: 2 });
    assert.deepEqual(sanitizeLogArg(set), { redacted: "Set", size: 2 });
    assert.deepEqual(sanitizeLogArg(new WeakMap()), { redacted: "WeakMap" });
    class Students extends Map<string, string> {}
    assert.deepEqual(sanitizeLogArg(new Students([["k", CLERK_ID]])), { redacted: "Students", size: 1 });
    const out = sanitizeLogArgs(["x", map, { nested: [set] }]);
    assert.deepEqual(out, ["x", { redacted: "Map", size: 2 }, { nested: [{ redacted: "Set", size: 2 }] }]);
    assertClean(format(...out));
    assert.doesNotMatch(format(...out), /example\.invalid/);
  });

  it("logs a class instance as its class name only, whatever its fields", () => {
    class Box {
      token = TOKEN;
      email = "fake@example.invalid";
      error = new Error(CLERK_ID);
    }
    assert.deepEqual(sanitizeLogArg(new Box()), { redacted: "Box" });
    assert.deepEqual(sanitizeLogArg(new Date(0)), { redacted: "Date" });
    assert.deepEqual(sanitizeLogArg(new URL("https://fake.example.invalid/a?b=1")), { redacted: "URL" });
    assert.deepEqual(sanitizeLogArg(Object.create({ inherited: TOKEN })), { redacted: "Object" });
    // A constructor name that isn't identifier-like is dropped.
    const odd = Object.create({ constructor: { name: CLERK_ID + " fake@example.invalid" } });
    assert.deepEqual(sanitizeLogArg(odd), { redacted: "Object" });
    const { target, output } = capturingConsole();
    installSafeConsole(target);
    target.error("x", new Box(), { box: new Box() });
    target.dir(new Box(), { depth: null });
    assertClean(output());
    assert.doesNotMatch(output(), /example\.invalid/);
  });

  it("keeps a plain null-prototype object as it is", () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { readingId: "r1" });
    assert.equal(sanitizeLogArg(bare), bare);
  });
});

describe("sanitizeLogArg never throws", () => {
  const throwing = () => {
    throw new Error(`boom ${CLERK_ID}`);
  };

  it("a throwing getter on a plain object", () => {
    const value = { readingId: "r1" } as Record<string, unknown>;
    Object.defineProperty(value, "secret", { enumerable: true, get: throwing });
    assert.deepEqual(sanitizeLogArg(value), { redacted: "Unloggable" });
    assert.deepEqual(sanitizeLogArg({ ok: 1, inner: value }), { ok: 1, inner: { redacted: "Unloggable" } });
  });

  it("a revoked Proxy, at the top or nested", () => {
    const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});
    revoke();
    assert.deepEqual(sanitizeLogArg(proxy), { redacted: "Unloggable" });
    assert.deepEqual(sanitizeLogArg({ inner: proxy }), { inner: { redacted: "Unloggable" } });
    assert.deepEqual(safeErrorFields(proxy), { name: "UnloggableError", causes: [], timedOut: false });
  });

  it("an Error whose name, code, cause, or message getter throws", () => {
    for (const field of ["name", "code", "cause", "message", "stack", "digest", "sourceError"]) {
      const error = new Error(CLERK_ID);
      Object.defineProperty(error, field, { get: throwing });
      const out = sanitizeLogArg(error) as Record<string, unknown>;
      assert.equal(typeof out.name, "string", field);
      assert.ok(Array.isArray(out.causes), field);
      assertClean(format(out));
      assert.doesNotThrow(() => safeErrorFields(error), field);
    }
    const badName = new Error("x");
    Object.defineProperty(badName, "name", { get: throwing });
    assert.equal((safeErrorFields(badName) as { name: string }).name, "UnloggableError");
    const badCause = Object.assign(new Error("x"), { code: "23505" });
    Object.defineProperty(badCause, "cause", { get: throwing });
    assert.deepEqual(safeErrorFields(badCause), { name: "Error", code: "23505", causes: [], timedOut: false });
  });

  it("a proxy whose traps throw, and a Symbol.toStringTag getter that throws", () => {
    const trap = new Proxy(new Error(CLERK_ID), { get: throwing, getPrototypeOf: throwing });
    assert.doesNotThrow(() => sanitizeLogArg(trap));
    assertClean(format(sanitizeLogArg(trap)));
    const tagged = { [Symbol.toStringTag]: undefined } as Record<PropertyKey, unknown>;
    Object.defineProperty(tagged, Symbol.toStringTag, { get: throwing });
    assert.doesNotThrow(() => sanitizeLogArg(tagged));
    assert.doesNotThrow(() => safeErrorFields(tagged));
  });

  it("a toString that throws: the wrapped console still logs, and never throws", () => {
    const { target, output } = capturingConsole();
    installSafeConsole(target);
    class Loud {
      toString(): string {
        return throwing();
      }
    }
    const plain = { toString: throwing };
    assert.doesNotThrow(() => target.error("%s", new Loud()));
    assert.doesNotThrow(() => target.error("%s", plain));
    assert.doesNotThrow(() => target.assert(false, "%s", plain));
    const errorWithToString = Object.assign(new Error(CLERK_ID), { toString: throwing });
    assert.doesNotThrow(() => target.error("%s", errorWithToString));
    const text = output();
    assertClean(text);
    assert.match(text, /Loud/);
    assert.match(text, /unloggable log line/);
  });
});

describe("sanitizeLogArg depth", () => {
  // A chain of plain objects: depth 0 is the argument itself.
  function nested(levels: number, leaf: unknown): Record<string, unknown> {
    let value: unknown = leaf;
    for (let i = 0; i < levels; i += 1) value = { next: value };
    return value as Record<string, unknown>;
  }
  function at(value: unknown, levels: number): unknown {
    let current = value;
    for (let i = 0; i < levels; i += 1) current = (current as Record<string, unknown>).next;
    return current;
  }

  it("walks plain objects down to MAX_DEPTH - 1, keeping their contents", () => {
    assert.equal(MAX_DEPTH, 5);
    const value = nested(MAX_DEPTH - 1, { readingId: "r1" });
    assert.equal(sanitizeLogArg(value), value);
  });

  it("an error at MAX_DEPTH, and past it, still becomes its safe fields or the marker", () => {
    const atLimit = sanitizeLogArg(nested(MAX_DEPTH, new Error(CLERK_ID)));
    assert.deepEqual(at(atLimit, MAX_DEPTH), { name: "Error", causes: [], timedOut: false });
    const past = sanitizeLogArg(nested(MAX_DEPTH + 3, new Error(CLERK_ID)));
    assert.deepEqual(at(past, MAX_DEPTH), { redacted: "TooDeep" });
    assertClean(inspect(past, { depth: null }));
  });

  it("a plain object at MAX_DEPTH is never printed as it is", () => {
    const value = nested(MAX_DEPTH, { email: "fake@example.invalid", token: TOKEN });
    const out = sanitizeLogArg(value);
    assert.notEqual(out, value);
    assert.deepEqual(at(out, MAX_DEPTH), { redacted: "TooDeep" });
    const { target, output } = capturingConsole();
    installSafeConsole(target);
    target.dir(nested(MAX_DEPTH + 10, new Error(CLERK_ID)), { depth: null });
    target.log("%o", nested(MAX_DEPTH + 1, { token: TOKEN }));
    assertClean(output());
  });

  it("a cycle at and past the limit", () => {
    const deep = nested(MAX_DEPTH + 2, null);
    (at(deep, MAX_DEPTH + 1) as Record<string, unknown>).next = deep;
    (at(deep, 2) as Record<string, unknown>).error = new Error(CLERK_ID);
    const out = sanitizeLogArg(deep);
    assertClean(inspect(out, { depth: null }));
    assert.deepEqual(at(out, MAX_DEPTH), { redacted: "TooDeep" });
    // A cycle inside the limit points at the copy.
    const short = nested(MAX_DEPTH - 2, null);
    (at(short, MAX_DEPTH - 3) as Record<string, unknown>).loop = short;
    (short as Record<string, unknown>).error = new Error(CLERK_ID);
    const copy = sanitizeLogArg(short) as Record<string, unknown>;
    assert.equal((at(copy, MAX_DEPTH - 3) as Record<string, unknown>).loop, copy);
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
