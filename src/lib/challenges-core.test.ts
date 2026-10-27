import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Statement } from "./link-rate-limit";
import {
  CHALLENGE_ALREADY_SENT_MESSAGE,
  CHALLENGE_NOT_READY_MESSAGE,
  CHALLENGE_SENT_MESSAGE,
  CHALLENGE_UNIQUE_CONSTRAINT,
  challengeDiagnosis,
  challengeInsertStatement,
  challengeMessage,
  sendChallengeWith,
} from "./challenges-core";
import { isUniqueViolation } from "./pg-errors";
import { MAX_TRIES, NOTE_EMPTY_MESSAGE } from "./validate-answers";

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
  it("inserts only after 3 failed tries, no pass, in the student's class, without ON CONFLICT", () => {
    const s = challengeInsertStatement(S, R, "note");
    assert.match(s.text, /insert into challenges \(student_id, reading_id, note\)/);
    assert.match(s.text, /r\.status = 'published'/);
    assert.match(s.text, /result = 'fail'\) >= \$4::int/);
    assert.match(s.text, /and not exists \(\s*select 1 from attempts[\s\S]*result = 'pass'/);
    assert.doesNotMatch(s.text, /on conflict/i);
    assert.deepEqual(s.params, [S, R, "note", MAX_TRIES]);
  });
});

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

  it("says why nothing was inserted", async () => {
    const run = (row: Record<string, unknown>) => sendChallengeWith(S, R, "n", fakeExecutor([[[]], [[row]]]).execute);
    assert.deepEqual(await run({ eligible: true, passed: false, fails: 2, sent: false }), { status: "not_ready" });
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
