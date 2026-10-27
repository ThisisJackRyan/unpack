import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Statement } from "./link-rate-limit";
import {
  CHALLENGE_ALREADY_SENT_MESSAGE,
  CHALLENGE_BUSY_MESSAGE,
  CHALLENGE_NOT_READY_MESSAGE,
  CHALLENGE_SENT_MESSAGE,
  CHALLENGE_UNIQUE_CONSTRAINT,
  challengeDiagnosis,
  challengeDiagnosisStatement,
  challengeMessage,
  challengeOutcome,
  challengeSendStatements,
  sendChallengeWith,
} from "./challenges-core";
import { isUniqueViolation } from "./pg-errors";
import { EFFORT_CLAIM_STALE_SECONDS } from "./submit-answers-core";
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

describe("challengeSendStatements", () => {
  const [lock, insert, diagnosis] = challengeSendStatements(S, R, "note");

  it("take the submit's (student, reading) advisory lock first", () => {
    assert.match(lock.text, /pg_advisory_xact_lock\(\$1::int, hashtext\(\$2::text\)\)/);
    assert.deepEqual(lock.params, [3, `${S}:${R}`]);
  });

  it("insert the next round only when every rule holds, without ON CONFLICT", () => {
    assert.match(insert.text, /insert into challenges \(student_id, reading_id, note, round\)/);
    assert.match(insert.text, /\(select coalesce\(max\(round\), 0\) \+ 1 from challenges where student_id = \$1::uuid and reading_id = \$2::uuid\)/);
    assert.match(insert.text, /r\.status = 'published'/);
    assert.match(insert.text, /and not exists \(\s*select 1 from attempts[\s\S]*result = 'pass'/);
    // Open, approved, closed, or denied without one more try all block.
    assert.match(insert.text, /and not exists \(\s*select 1 from challenges[\s\S]*and \(status <> 'denied' or tries_allowed is null\)/);
    // Out of tries or checks, by the student's own limits, in one
    // parenthesized "or" so it can't loosen the other rules.
    assert.match(
      insert.text,
      new RegExp(
        `and \\(\\(select count\\(\\*\\) from attempts\\s+where [^)]*result = 'fail'\\) >= coalesce\\(\\(select g\\.tries_allowed[\\s\\S]*?, ${MAX_TRIES}\\) or \\(select count\\(\\*\\) from effort_checks where student_id = \\$1::uuid and reading_id = \\$2::uuid\\) >= coalesce\\(\\(select g\\.checks_allowed[\\s\\S]*?, ${EFFORT_CHECK_LIMIT}\\)\\)`,
      ),
    );
    // No check running (the second-tab race at the last check).
    assert.match(
      insert.text,
      /and not exists \(\s*select 1 from effort_checks[\s\S]*finished_at is null and created_at > now\(\) - make_interval\(secs => \$4::int\)\s*\)\s*returning id$/,
    );
    assert.doesNotMatch(insert.text, /on conflict/i);
    assert.deepEqual(insert.params, [S, R, "note", EFFORT_CLAIM_STALE_SECONDS]);
  });

  it("diagnose in the same batch, with the limits, the live check, and the blocking challenge", () => {
    assert.deepEqual(diagnosis, challengeDiagnosisStatement(S, R));
    assert.match(diagnosis.text, /result = 'fail'\)::int as fails/);
    assert.match(diagnosis.text, /as tries_allowed/);
    assert.match(diagnosis.text, /as checks_allowed/);
    assert.match(diagnosis.text, /make_interval\(secs => \$3::int\)\s*\) as live/);
    assert.match(diagnosis.text, /order by round desc limit 1\) as blocking$/);
    assert.deepEqual(diagnosis.params, [S, R, EFFORT_CLAIM_STALE_SECONDS]);
  });

  it("use every parameter they pass", () => {
    for (const s of [insert, diagnosis]) {
      for (let i = 1; i <= s.params.length; i++) assert.match(s.text, new RegExp(`\\$${i}::`));
      assert.doesNotMatch(s.text, new RegExp(`\\$${s.params.length + 1}\\b`));
    }
  });
});

// A fake of the locked insert's rules, for the flow tests. The lock makes
// each send one step, so a second send sees the first one's row.
type FakeState = {
  fails: number;
  checks: number;
  passed?: boolean;
  live?: boolean;
  limits?: { tries: number; checks: number };
  rounds?: { status: string; extraTry: boolean }[];
};
function fakeDb(state: FakeState) {
  const rounds = state.rounds ?? [];
  const execute = async (statements: Statement[]) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    const limits = state.limits ?? { tries: MAX_TRIES, checks: EFFORT_CHECK_LIMIT };
    const blocking = [...rounds].reverse().find((r) => r.status !== "denied" || !r.extraTry);
    const ready = state.fails >= limits.tries || state.checks >= limits.checks;
    const ok = !state.passed && !blocking && ready && !state.live;
    if (ok) rounds.push({ status: "open", extraTry: false });
    const diagnosis = {
      eligible: true,
      passed: state.passed === true,
      fails: state.fails,
      checks: state.checks,
      tries_allowed: limits.tries,
      checks_allowed: limits.checks,
      live: state.live === true,
      blocking: blocking?.status ?? null,
    };
    assert.equal(statements.length, 3);
    return [[{}], ok ? [{ id: `c${rounds.length}` }] : [], [diagnosis]];
  };
  return { execute, rounds };
}

describe("sendChallengeWith", () => {
  it("sends a cleaned note", async () => {
    const { execute, calls } = fakeExecutor([[[{}], [{ id: "c1" }], [{}]]]);
    assert.deepEqual(await sendChallengeWith(S, R, "  Please look.\u0000 ", execute), { status: "sent" });
    assert.equal(calls[0][1].params[2], "Please look.");
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
      assert.equal(atLimit.rounds.length, 1);
      const below = fakeDb({ fails, checks: EFFORT_CHECK_LIMIT - 1 });
      assert.deepEqual(await sendChallengeWith(S, R, "n", below.execute), { status: "not_ready" }, `${fails} fails below the limit`);
      assert.equal(below.rounds.length, 0);
    }
    const passed = fakeDb({ fails: 1, checks: EFFORT_CHECK_LIMIT, passed: true });
    assert.deepEqual(await sendChallengeWith(S, R, "n", passed.execute), { status: "already_passed" });
  });

  it("waits while the last check is still running (a second tab), then sends", async () => {
    const state: FakeState = { fails: 2, checks: EFFORT_CHECK_LIMIT, live: true };
    const db = fakeDb(state);
    const busy = await Promise.all(Array.from({ length: 5 }, () => sendChallengeWith(S, R, "n", db.execute)));
    assert.deepEqual(new Set(busy.map((r) => r.status)), new Set(["busy"]));
    assert.equal(db.rounds.length, 0);
    // The check finished as a fail: the note goes through.
    Object.assign(state, { live: false, fails: 3 });
    assert.deepEqual(await sendChallengeWith(S, R, "n", db.execute), { status: "sent" });
    // Or it passed: nothing to send.
    const passedState: FakeState = { fails: 2, checks: EFFORT_CHECK_LIMIT, live: true };
    const passedDb = fakeDb(passedState);
    Object.assign(passedState, { live: false, passed: true });
    assert.deepEqual(await sendChallengeWith(S, R, "n", passedDb.execute), { status: "already_passed" });
    assert.equal(passedDb.rounds.length, 0);
  });

  it("20 parallel sends: one sent, the rest already sent", async () => {
    const db = fakeDb({ fails: 1, checks: EFFORT_CHECK_LIMIT });
    const results = await Promise.all(Array.from({ length: 20 }, () => sendChallengeWith(S, R, "n", db.execute)));
    assert.equal(db.rounds.length, 1);
    assert.equal(results.filter((r) => r.status === "sent").length, 1);
    assert.equal(results.filter((r) => r.status === "already_sent").length, 19);
  });

  it("after a denial with one more try: not until that try is used, then a new round", async () => {
    const state: FakeState = {
      fails: MAX_TRIES,
      checks: MAX_TRIES,
      limits: { tries: MAX_TRIES + 1, checks: MAX_TRIES + 2 },
      rounds: [{ status: "denied", extraTry: true }],
    };
    const db = fakeDb(state);
    assert.deepEqual(await sendChallengeWith(S, R, "n", db.execute), { status: "not_ready" });
    state.fails = MAX_TRIES + 1;
    state.checks = MAX_TRIES + 1;
    const results = await Promise.all(Array.from({ length: 10 }, () => sendChallengeWith(S, R, "n", db.execute)));
    assert.equal(results.filter((r) => r.status === "sent").length, 1);
    assert.equal(results.filter((r) => r.status === "already_sent").length, 9);
    assert.equal(db.rounds.length, 2);
  });

  it("a denial without one more try is final", async () => {
    const db = fakeDb({ fails: MAX_TRIES, checks: MAX_TRIES, rounds: [{ status: "denied", extraTry: false }] });
    assert.deepEqual(await sendChallengeWith(S, R, "n", db.execute), { status: "decided" });
    assert.equal(db.rounds.length, 1);
  });
});

describe("challengeDiagnosis", () => {
  const base = { eligible: true, passed: false, fails: 0, checks: 0, tries_allowed: 3, checks_allowed: 6, live: false, blocking: null };

  it("reads each reason in order", () => {
    assert.deepEqual(challengeDiagnosis({ ...base, eligible: false, blocking: "open" }), { status: "not_found" });
    assert.deepEqual(challengeDiagnosis({ ...base, passed: true, blocking: "open" }), { status: "already_passed" });
    assert.deepEqual(challengeDiagnosis({ ...base, blocking: "approved" }), { status: "already_passed" });
    assert.deepEqual(challengeDiagnosis({ ...base, blocking: "closed" }), { status: "already_passed" });
    assert.deepEqual(challengeDiagnosis({ ...base, blocking: "open", live: true }), { status: "already_sent" });
    assert.deepEqual(challengeDiagnosis({ ...base, blocking: "denied", live: true }), { status: "decided" });
    assert.deepEqual(challengeDiagnosis({ ...base, live: true, fails: 2 }), { status: "busy" });
    assert.deepEqual(challengeDiagnosis({ ...base, fails: MAX_TRIES - 1, checks: EFFORT_CHECK_LIMIT - 1 }), { status: "not_ready" });
    assert.deepEqual(challengeDiagnosis({ ...base, fails: 3, tries_allowed: 4 }), { status: "not_ready" });
    assert.deepEqual(challengeDiagnosis(undefined), { status: "not_found" });
  });

  it("calls a ready student with nothing saved a failure to retry, not not_ready", () => {
    assert.deepEqual(challengeDiagnosis({ ...base, fails: MAX_TRIES }), { status: "not_found" });
    assert.deepEqual(challengeDiagnosis({ ...base, fails: 1, checks: EFFORT_CHECK_LIMIT }), { status: "not_found" });
  });

  it("reads a sent batch first", () => {
    assert.deepEqual(challengeOutcome([[{}], [{ id: "c1" }], [base]]), { status: "sent" });
    assert.deepEqual(challengeOutcome([[{}], [], [{ ...base, live: true }]]), { status: "busy" });
    assert.deepEqual(challengeOutcome([]), { status: "not_found" });
  });
});

describe("challengeMessage", () => {
  it("has a student message for each outcome", () => {
    assert.equal(challengeMessage({ status: "sent" }), CHALLENGE_SENT_MESSAGE);
    assert.equal(challengeMessage({ status: "already_sent" }), CHALLENGE_ALREADY_SENT_MESSAGE);
    assert.equal(challengeMessage({ status: "not_ready" }), CHALLENGE_NOT_READY_MESSAGE);
    assert.equal(challengeMessage({ status: "busy" }), CHALLENGE_BUSY_MESSAGE);
    assert.equal(challengeMessage({ status: "invalid", error: "x" }), "x");
    assert.match(CHALLENGE_SENT_MESSAGE, /Your teacher will take a look/);
    assert.equal(CHALLENGE_BUSY_MESSAGE, "We’re still checking your answers. Try again in a minute.");
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
