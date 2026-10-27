import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Statement } from "./link-rate-limit";
import {
  CHALLENGE_ALREADY_SENT_MESSAGE,
  CHALLENGE_NOT_READY_MESSAGE,
  CHALLENGE_SENT_MESSAGE,
  CHALLENGE_UNIQUE_CONSTRAINT,
  challengeDiagnosis,
  challengeDiagnosisStatement,
  challengeInsertStatement,
  challengeMessage,
  sendChallengeWith,
} from "./challenges-core";
import { isUniqueViolation } from "./pg-errors";
import { EFFORT_CHECK_LIMIT, MAX_TRIES, NOTE_EMPTY_MESSAGE } from "./validate-answers";

const S = "s1";
const R = "r1";

function fakeExecutor(responses: (Record<string, unknown>[][] | Error)[]) {
  const calls: Statement[][] = [];
  const execute = async (statements: Statement[]) => {
    calls.push(statements);
    const next = responses.shift() ?? [];
    if (next instanceof Error) throw next;
    return next;
  };
  return { execute, calls };
}

const dup = (constraint = CHALLENGE_UNIQUE_CONSTRAINT) =>
  Object.assign(new Error("duplicate key"), { code: "23505", constraint });

describe("challengeInsertStatement", () => {
  it("inserts only with no pass, in the student's class, after 3 failed tries or at the check limit, without ON CONFLICT", () => {
    const s = challengeInsertStatement(S, R, "note");
    assert.match(s.text, /insert into challenges \(student_id, reading_id, note\)/);
    assert.match(s.text, /r\.status = 'published'/);
    assert.match(s.text, /and not exists \(\s*select 1 from attempts[\s\S]*result = 'pass'/);
    // Either rule opens it: one "or", in parentheses, so it can't loosen the
    // eligibility and no-pass conditions.
    assert.match(
      s.text,
      /and \(\(select count\(\*\) from attempts\s+where [^)]*result = 'fail'\) >= \$4::int or \(select count\(\*\) from effort_checks where student_id = \$1::uuid and reading_id = \$2::uuid\) >= \$5::int\)\s+returning id$/,
    );
    assert.equal(s.text.match(/\bor\b/g)?.length, 1);
    assert.doesNotMatch(s.text, /on conflict/i);
    assert.deepEqual(s.params, [S, R, "note", MAX_TRIES, EFFORT_CHECK_LIMIT]);
    for (let i = 1; i <= s.params.length; i++) assert.match(s.text, new RegExp(`\\$${i}::`));
  });

  it("diagnoses with the fails and checks counts", () => {
    const d = challengeDiagnosisStatement(S, R);
    assert.match(d.text, /result = 'fail'\)::int as fails/);
    assert.match(d.text, /from effort_checks where student_id = \$1::uuid and reading_id = \$2::uuid\)::int as checks/);
    assert.deepEqual(d.params, [S, R]);
  });
});

// A fake of the insert's rule (and the unique index), for the flow tests.
function fakeDb(state: { fails: number; checks: number; passed?: boolean }) {
  let saved = 0;
  const ready = () => !state.passed && (state.fails >= MAX_TRIES || state.checks >= EFFORT_CHECK_LIMIT);
  const execute = async (statements: Statement[]) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (!statements[0].text.startsWith("insert")) {
      return [[{ eligible: true, passed: state.passed === true, fails: state.fails, checks: state.checks, sent: saved > 0 }]];
    }
    if (!ready()) return [[]];
    if (saved > 0) throw dup();
    saved++;
    return [[{ id: "c1" }]];
  };
  return { execute, saved: () => saved };
}

describe("sendChallengeWith", () => {
  it("sends a cleaned note", async () => {
    const { execute, calls } = fakeExecutor([[[{ id: "c1" }]]]);
    assert.deepEqual(await sendChallengeWith(S, R, "  Please look.\u0000 ", execute), { status: "sent" });
    assert.equal(calls[0][0].params[2], "Please look.");
  });

  it("refuses a blank note without touching the database", async () => {
    const { execute, calls } = fakeExecutor([]);
    assert.deepEqual(await sendChallengeWith(S, R, "  ", execute), { status: "invalid", error: NOTE_EMPTY_MESSAGE });
    assert.equal(calls.length, 0);
  });

  it("maps the challenge's own 23505 (also wrapped) to already sent", async () => {
    assert.deepEqual(await sendChallengeWith(S, R, "n", fakeExecutor([dup()]).execute), { status: "already_sent" });
    const wrapped = Object.assign(new Error("query failed"), { cause: dup() });
    assert.deepEqual(await sendChallengeWith(S, R, "n", fakeExecutor([wrapped]).execute), { status: "already_sent" });
  });

  it("rethrows a 23505 on another constraint and other errors (fail closed)", async () => {
    await assert.rejects(sendChallengeWith(S, R, "n", fakeExecutor([dup("other_unique")]).execute), /duplicate key/);
    await assert.rejects(sendChallengeWith(S, R, "n", fakeExecutor([new Error("db down")]).execute), /db down/);
  });

  it("opens at the check limit with fewer than 3 tries, and not below it", async () => {
    for (const fails of [0, 1, MAX_TRIES - 1]) {
      const atLimit = fakeDb({ fails, checks: EFFORT_CHECK_LIMIT });
      assert.deepEqual(await sendChallengeWith(S, R, "n", atLimit.execute), { status: "sent" }, `${fails} fails at the limit`);
      assert.equal(atLimit.saved(), 1);
      const below = fakeDb({ fails, checks: EFFORT_CHECK_LIMIT - 1 });
      assert.deepEqual(await sendChallengeWith(S, R, "n", below.execute), { status: "not_ready" }, `${fails} fails below the limit`);
      assert.equal(below.saved(), 0);
    }
    const passed = fakeDb({ fails: 1, checks: EFFORT_CHECK_LIMIT, passed: true });
    assert.deepEqual(await sendChallengeWith(S, R, "n", passed.execute), { status: "already_passed" });
  });

  it("20 parallel sends at the check limit: one sent, the rest already sent", async () => {
    const db = fakeDb({ fails: 1, checks: EFFORT_CHECK_LIMIT });
    const results = await Promise.all(Array.from({ length: 20 }, () => sendChallengeWith(S, R, "n", db.execute)));
    assert.equal(db.saved(), 1);
    assert.equal(results.filter((r) => r.status === "sent").length, 1);
    assert.equal(results.filter((r) => r.status === "already_sent").length, 19);
  });

  it("says why nothing was inserted", async () => {
    const run = (row: Record<string, unknown>) => sendChallengeWith(S, R, "n", fakeExecutor([[[]], [[row]]]).execute);
    assert.deepEqual(await run({ eligible: true, passed: false, fails: 2, checks: 2, sent: false }), { status: "not_ready" });
    assert.deepEqual(await run({ eligible: true, passed: false, fails: 0, checks: EFFORT_CHECK_LIMIT - 1, sent: false }), { status: "not_ready" });
    assert.deepEqual(await run({ eligible: true, passed: true, fails: 1, sent: false }), { status: "already_passed" });
    assert.deepEqual(await run({ eligible: true, passed: false, fails: 3, sent: true }), { status: "already_sent" });
    assert.deepEqual(await run({ eligible: false, passed: false, fails: 3, sent: false }), { status: "not_found" });
    assert.deepEqual(challengeDiagnosis(undefined), { status: "not_found" });
  });

  it("20 parallel sends against a unique index: one sent, the rest already sent", async () => {
    let saved = 0;
    const execute = async (statements: Statement[]) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (!statements[0].text.startsWith("insert")) return [[{ eligible: true, sent: true }]];
      if (saved > 0) throw dup();
      saved++;
      return [[{ id: "c1" }]];
    };
    const results = await Promise.all(Array.from({ length: 20 }, () => sendChallengeWith(S, R, "n", execute)));
    assert.equal(saved, 1);
    assert.equal(results.filter((r) => r.status === "sent").length, 1);
    assert.equal(results.filter((r) => r.status === "already_sent").length, 19);
  });
});

describe("challengeDiagnosis", () => {
  const base = { eligible: true, passed: false, fails: 0, checks: 0, sent: false };

  it("reads each reason in order", () => {
    assert.deepEqual(challengeDiagnosis({ ...base, eligible: false, sent: true }), { status: "not_found" });
    assert.deepEqual(challengeDiagnosis({ ...base, sent: true, passed: true }), { status: "already_sent" });
    assert.deepEqual(challengeDiagnosis({ ...base, passed: true, checks: EFFORT_CHECK_LIMIT }), { status: "already_passed" });
    assert.deepEqual(challengeDiagnosis({ ...base, fails: MAX_TRIES - 1, checks: EFFORT_CHECK_LIMIT - 1 }), { status: "not_ready" });
  });

  it("calls a ready student with nothing saved a failure to retry, not not_ready", () => {
    // The state changed between the insert and the diagnosis.
    assert.deepEqual(challengeDiagnosis({ ...base, fails: MAX_TRIES }), { status: "not_found" });
    assert.deepEqual(challengeDiagnosis({ ...base, fails: 1, checks: EFFORT_CHECK_LIMIT }), { status: "not_found" });
  });
});

describe("challengeMessage", () => {
  it("has a student message for each outcome", () => {
    assert.equal(challengeMessage({ status: "sent" }), CHALLENGE_SENT_MESSAGE);
    assert.equal(challengeMessage({ status: "already_sent" }), CHALLENGE_ALREADY_SENT_MESSAGE);
    assert.equal(challengeMessage({ status: "not_ready" }), CHALLENGE_NOT_READY_MESSAGE);
    assert.equal(challengeMessage({ status: "invalid", error: "x" }), "x");
    assert.match(CHALLENGE_SENT_MESSAGE, /Your teacher will take a look/);
  });
});

describe("isUniqueViolation", () => {
  it("matches 23505, optionally on one constraint, through causes", () => {
    assert.equal(isUniqueViolation(dup()), true);
    assert.equal(isUniqueViolation(dup(), CHALLENGE_UNIQUE_CONSTRAINT), true);
    assert.equal(isUniqueViolation(dup("x"), CHALLENGE_UNIQUE_CONSTRAINT), false);
    assert.equal(isUniqueViolation({ cause: { cause: dup() } }), true);
    assert.equal(isUniqueViolation(new Error("x")), false);
    assert.equal(isUniqueViolation(null), false);
  });
});
