import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EFFORT_CHECK_DEADLINE_MS } from "./ai/settings";
import type { EffortCheckInput, EffortVerdict } from "./ai/effort-check";
import type { Statement } from "./link-rate-limit";
import {
  ALREADY_PASSED_MESSAGE,
  CHECK_BUSY_MESSAGE,
  CHECK_FAILED_MESSAGE,
  claimOutcome,
  claimStatements,
  commitStatements,
  committedTry,
  EFFORT_CHECK_LIMIT,
  EFFORT_CLAIM_STALE_SECONDS,
  OUT_OF_TRIES_MESSAGE,
  postgresAttemptStore,
  releaseStatement,
  submitAnswersWith,
  submitContextStatements,
  submitLookup,
  submitMessage,
  TOO_MANY_CHECKS_MESSAGE,
  type AttemptStore,
  type SubmitResult,
} from "./submit-answers-core";
import { ANSWER_EMPTY_MESSAGE, ANSWERS_STALE_MESSAGE, MAX_TRIES } from "./validate-answers";

const STUDENT = "s1";
const READING = "r1";
const QUESTIONS = [
  { id: "q1", position: 1, prompt: "Why did Mia go out?" },
  { id: "q2", position: 2, prompt: "What did the fox do?" },
];
const ANSWERS = [
  { questionId: "q1", value: "to see the snow" },
  { questionId: "q2", value: "it ran away" },
];
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

type Check = { id: string; createdAt: number; finished: boolean; outcome: string | null };
type Attempt = { tryNumber: number; passed: boolean; answers: { questionId: string; text: string; pass: boolean; nudge: string }[] };

// In-memory store with the same rules as the Postgres one: the claim and
// the commit are each one atomic step (the advisory lock makes the counts
// and the write one step). Every call yields first, so concurrent callers
// interleave.
function fakeStore(options: { eligible?: boolean; questions?: typeof QUESTIONS } = {}) {
  const checks: Check[] = [];
  const attempts: Attempt[] = [];
  let now = 0;
  const live = () => checks.some((c) => !c.finished && now - c.createdAt < EFFORT_CLAIM_STALE_SECONDS);
  const passed = () => attempts.some((a) => a.passed);
  const store: AttemptStore = {
    async loadContext() {
      await tick();
      if (options.eligible === false) return { status: "not_found" };
      return {
        status: "ok",
        context: {
          bodyText: "text",
          gradeLevel: "3",
          questions: options.questions ?? QUESTIONS,
          tries: attempts.length,
          passed: passed(),
        },
      };
    },
    async claim(_s, _r, claimId) {
      await tick();
      if (options.eligible === false) return "not_found";
      if (passed()) return "already_passed";
      if (attempts.length >= MAX_TRIES) return "out_of_tries";
      if (live()) return "busy";
      if (checks.length >= EFFORT_CHECK_LIMIT) return "too_many_checks";
      checks.push({ id: claimId, createdAt: now, finished: false, outcome: null });
      return "claimed";
    },
    async release(_s, _r, claimId) {
      await tick();
      const c = checks.find((x) => x.id === claimId);
      if (c && !c.finished) Object.assign(c, { finished: true, outcome: "error" });
    },
    async commit(input) {
      await tick();
      const c = checks.find((x) => x.id === input.claimId);
      if (!c || c.finished || now - c.createdAt >= EFFORT_CLAIM_STALE_SECONDS) return null;
      if (attempts.length >= MAX_TRIES || passed()) return null;
      Object.assign(c, { finished: true, outcome: input.passed ? "pass" : "fail" });
      const tryNumber = attempts.length + 1;
      attempts.push({ tryNumber, passed: input.passed, answers: input.verdicts });
      return tryNumber;
    },
  };
  return { store, checks, attempts, advance: (s: number) => void (now += s) };
}

// Fake effort checker: passes everything unless told otherwise, takes a
// moment like a real call, and counts calls.
function fakeChecker(verdict: (input: EffortCheckInput) => EffortVerdict[] | Error = passAll, delayMs = 5) {
  let calls = 0;
  const check = async (input: EffortCheckInput) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const out = verdict(input);
    if (out instanceof Error) throw out;
    return out;
  };
  return { check, calls: () => calls };
}

function passAll(input: EffortCheckInput): EffortVerdict[] {
  return input.items.map((i) => ({ questionId: i.questionId, pass: true, nudge: "" }));
}

function failSecond(input: EffortCheckInput): EffortVerdict[] {
  return input.items.map((i, n) => ({
    questionId: i.questionId,
    pass: n !== 1,
    nudge: n === 1 ? "Look at what the fox did." : "",
  }));
}

let ids = 0;
const newId = () => `id${++ids}`;

function submit(store: AttemptStore, check: (input: EffortCheckInput) => Promise<EffortVerdict[]>, entries = ANSWERS) {
  return submitAnswersWith(STUDENT, READING, entries, { store, check, newId });
}

describe("submitAnswersWith", () => {
  it("checks all answers in one call and saves a passing try", async () => {
    const { store, attempts, checks } = fakeStore();
    const checker = fakeChecker();
    const r = await submit(store, checker.check);
    assert.deepEqual(r, {
      status: "checked",
      passed: true,
      tryNumber: 1,
      results: [
        { questionId: "q1", pass: true, nudge: "" },
        { questionId: "q2", pass: true, nudge: "" },
      ],
    });
    assert.equal(checker.calls(), 1);
    assert.deepEqual(attempts[0].answers.map((a) => a.text), ["to see the snow", "it ran away"]);
    assert.deepEqual(checks.map((c) => c.outcome), ["pass"]);
  });

  it("sends the questions and cleaned answers to the checker, in order", async () => {
    const { store } = fakeStore();
    let seen: EffortCheckInput | undefined;
    await submit(store, async (input) => {
      seen = input;
      return passAll(input);
    }, [
      { questionId: "q2", value: "  it ran away\u0000 " },
      { questionId: "q1", value: "to see the snow" },
    ]);
    assert.deepEqual(seen?.items, [
      { questionId: "q1", question: "Why did Mia go out?", answer: "to see the snow" },
      { questionId: "q2", question: "What did the fox do?", answer: "it ran away" },
    ]);
    assert.equal(seen?.gradeLevel, "3");
  });

  it("passes the attempt only when every answer passes", async () => {
    const { store, attempts } = fakeStore();
    const r = await submit(store, fakeChecker(failSecond).check);
    assert.equal(r.status, "checked");
    assert.equal(r.status === "checked" && r.passed, false);
    assert.deepEqual(r.status === "checked" && r.results[1], { questionId: "q2", pass: false, nudge: "Look at what the fox did." });
    assert.equal(attempts[0].passed, false);
  });

  it("drops a nudge the checker put on a passed answer", async () => {
    const { store } = fakeStore();
    const r = await submit(store, fakeChecker((input) =>
      input.items.map((i) => ({ questionId: i.questionId, pass: true, nudge: "Great!" })),
    ).check);
    assert.ok(r.status === "checked" && r.results.every((x) => x.nudge === ""));
  });

  it("allows 3 tries, then refuses try 4 without calling the model", async () => {
    const { store, attempts } = fakeStore();
    const checker = fakeChecker(failSecond);
    for (let i = 1; i <= MAX_TRIES; i++) {
      const r = await submit(store, checker.check);
      assert.equal(r.status === "checked" && r.tryNumber, i);
    }
    assert.deepEqual(await submit(store, checker.check), { status: "out_of_tries" });
    assert.equal(checker.calls(), MAX_TRIES);
    assert.equal(attempts.length, MAX_TRIES);
  });

  it("refuses anything after a pass", async () => {
    const { store } = fakeStore();
    const checker = fakeChecker();
    await submit(store, checker.check);
    assert.deepEqual(await submit(store, checker.check), { status: "already_passed" });
    assert.equal(checker.calls(), 1);
  });

  it("refuses wrong question ids and blank answers before claiming", async () => {
    const { store, checks } = fakeStore();
    const checker = fakeChecker();
    assert.deepEqual(await submit(store, checker.check, ANSWERS.slice(0, 1)), { status: "stale" });
    assert.deepEqual(await submit(store, checker.check, [...ANSWERS, { questionId: "q9", value: "x" }]), { status: "stale" });
    assert.deepEqual(await submit(store, checker.check, [...ANSWERS, ANSWERS[0]]), { status: "stale" });
    assert.deepEqual(await submit(store, checker.check, [ANSWERS[0], { questionId: "q2", value: " " }]), {
      status: "invalid",
      errors: { q2: ANSWER_EMPTY_MESSAGE },
    });
    assert.equal(checks.length, 0);
    assert.equal(checker.calls(), 0);
  });

  it("refuses a reading the student can't see, or one with no questions", async () => {
    const checker = fakeChecker();
    assert.deepEqual(await submit(fakeStore({ eligible: false }).store, checker.check), { status: "not_found" });
    assert.deepEqual(await submit(fakeStore({ questions: [] }).store, checker.check, []), { status: "not_found" });
    assert.equal(checker.calls(), 0);
  });

  it("20 concurrent submits: one check runs, the rest are busy", async () => {
    const { store, attempts, checks } = fakeStore();
    const checker = fakeChecker(failSecond, 30);
    const results = await Promise.all(Array.from({ length: 20 }, () => submit(store, checker.check)));
    const tally = (s: SubmitResult["status"]) => results.filter((r) => r.status === s).length;
    assert.equal(tally("checked"), 1);
    assert.equal(tally("busy"), 19);
    assert.equal(checker.calls(), 1);
    assert.equal(attempts.length, 1);
    assert.equal(checks.length, 1);
  });

  it("waves of concurrent submits never pass 3 tries or the check limit", async () => {
    const { store, attempts, checks } = fakeStore();
    const checker = fakeChecker(failSecond, 2);
    for (let wave = 0; wave < 6; wave++) {
      await Promise.all(Array.from({ length: 20 }, () => submit(store, checker.check)));
    }
    assert.equal(attempts.length, MAX_TRIES);
    assert.deepEqual(attempts.map((a) => a.tryNumber), [1, 2, 3]);
    assert.ok(checks.length <= EFFORT_CHECK_LIMIT);
    assert.equal(checker.calls(), checks.length);
  });

  it("a model failure doesn't use a try but counts toward the limit", async () => {
    const { store, attempts, checks } = fakeStore();
    const errors: unknown[] = [];
    const failing = fakeChecker(() => new Error("model down"));
    const r = await submitAnswersWith(STUDENT, READING, ANSWERS, {
      store,
      check: failing.check,
      newId,
      onError: (e) => errors.push(e),
    });
    assert.deepEqual(r, { status: "check_failed" });
    assert.equal(attempts.length, 0);
    assert.deepEqual(checks.map((c) => [c.finished, c.outcome]), [[true, "error"]]);
    assert.equal(errors.length, 1);
    const next = await submit(store, fakeChecker().check);
    assert.equal(next.status === "checked" && next.tryNumber, 1);
  });

  it("stops at EFFORT_CHECK_LIMIT checks, failures included", async () => {
    const { store, checks } = fakeStore();
    const failing = fakeChecker(() => new Error("model down"));
    for (let i = 0; i < EFFORT_CHECK_LIMIT; i++) {
      assert.deepEqual(await submit(store, failing.check), { status: "check_failed" });
    }
    const working = fakeChecker();
    assert.deepEqual(await submit(store, working.check), { status: "too_many_checks" });
    assert.equal(working.calls(), 0);
    assert.equal(failing.calls(), EFFORT_CHECK_LIMIT);
    assert.equal(checks.length, EFFORT_CHECK_LIMIT);
  });

  it("treats wrong verdicts from the checker as a failed check", async () => {
    const { store, attempts } = fakeStore();
    const r = await submit(store, fakeChecker((input) => passAll(input).slice(0, 1)).check);
    assert.deepEqual(r, { status: "check_failed" });
    assert.equal(attempts.length, 0);
  });

  it("a stale claim stops blocking, and its holder can't save", async () => {
    const { store, checks, attempts, advance } = fakeStore();
    let release!: () => void;
    const slow = submit(store, async (input) => {
      await new Promise<void>((resolve) => (release = resolve));
      return passAll(input);
    });
    while (checks.length === 0) await tick();
    assert.deepEqual(await submit(store, fakeChecker().check), { status: "busy" });
    advance(EFFORT_CLAIM_STALE_SECONDS);
    const fresh = await submit(store, fakeChecker(failSecond).check);
    assert.equal(fresh.status === "checked" && fresh.tryNumber, 1);
    release();
    assert.deepEqual(await slow, { status: "check_failed" });
    assert.equal(attempts.length, 1);
  });

  it("finishes the claim when the commit hits a unique or check violation", async () => {
    const { store, checks } = fakeStore();
    const conflicted: AttemptStore = {
      ...store,
      commit: async () => {
        throw Object.assign(new Error("dup"), { code: "23505" });
      },
    };
    assert.deepEqual(await submit(conflicted, fakeChecker().check), { status: "check_failed" });
    assert.equal(checks[0].outcome, "error");
  });

  it("fails closed: other database errors propagate", async () => {
    const { store } = fakeStore();
    const broken: AttemptStore = {
      ...store,
      claim: async () => {
        throw new Error("db down");
      },
    };
    await assert.rejects(submit(broken, fakeChecker().check), /db down/);
    const brokenLoad: AttemptStore = { ...store, loadContext: async () => Promise.reject(new Error("db down")) };
    await assert.rejects(submit(brokenLoad, fakeChecker().check), /db down/);
  });
});

describe("limits", () => {
  it("allow 6 checks per student per reading, with a stale timeout past the deadline", () => {
    assert.equal(EFFORT_CHECK_LIMIT, 6);
    assert.ok(EFFORT_CHECK_LIMIT > MAX_TRIES);
    assert.equal(EFFORT_CLAIM_STALE_SECONDS, 90);
    assert.ok(EFFORT_CLAIM_STALE_SECONDS * 1000 > EFFORT_CHECK_DEADLINE_MS);
  });
});

describe("messages", () => {
  it("are distinct for each outcome", () => {
    assert.equal(submitMessage("already_passed"), ALREADY_PASSED_MESSAGE);
    assert.equal(submitMessage("out_of_tries"), OUT_OF_TRIES_MESSAGE);
    assert.equal(submitMessage("busy"), CHECK_BUSY_MESSAGE);
    assert.equal(submitMessage("too_many_checks"), TOO_MANY_CHECKS_MESSAGE);
    assert.equal(submitMessage("check_failed"), CHECK_FAILED_MESSAGE);
    assert.equal(submitMessage("stale"), ANSWERS_STALE_MESSAGE);
    const all = [ALREADY_PASSED_MESSAGE, OUT_OF_TRIES_MESSAGE, CHECK_BUSY_MESSAGE, TOO_MANY_CHECKS_MESSAGE, CHECK_FAILED_MESSAGE];
    assert.equal(new Set(all).size, all.length);
    assert.match(TOO_MANY_CHECKS_MESSAGE, /Ask your teacher/);
    assert.match(CHECK_FAILED_MESSAGE, /didn’t use up a try/);
  });
});

describe("claim statements", () => {
  const statements = claimStatements(STUDENT, READING, "c1");

  it("lock (student, reading) in their own advisory lock space", () => {
    assert.match(statements[0].text, /pg_advisory_xact_lock\(\$1::int, hashtext\(\$2::text\)\)/);
    assert.deepEqual(statements[0].params, [3, `${STUDENT}:${READING}`]);
  });

  it("insert only when eligible, not passed, under 3 tries, no live claim, under the limit", () => {
    const insert = statements[1];
    assert.match(insert.text, /insert into effort_checks \(id, student_id, reading_id\)/);
    assert.match(insert.text, /r\.status = 'published'/);
    assert.match(insert.text, /not exists \(\s*select 1 from attempts[\s\S]*result = 'pass'/);
    assert.match(insert.text, /from attempts where student_id = \$1::uuid and reading_id = \$2::uuid\) < \$4::int/);
    assert.match(insert.text, /and not exists \(\s*select 1 from effort_checks[\s\S]*finished_at is null and created_at > now\(\) - make_interval\(secs => \$5::int\)/);
    assert.match(insert.text, /from effort_checks where student_id = \$1::uuid and reading_id = \$2::uuid\) < \$6::int/);
    assert.deepEqual(insert.params, [STUDENT, READING, "c1", MAX_TRIES, EFFORT_CLAIM_STALE_SECONDS, EFFORT_CHECK_LIMIT]);
  });

  it("use every parameter they pass", () => {
    for (const s of [...statements, ...commitStatements(SAVE), releaseStatement(STUDENT, READING, "c1"), ...submitContextStatements(STUDENT, READING)]) {
      for (let i = 1; i <= s.params.length; i++) assert.match(s.text, new RegExp(`\\$${i}::`), `$${i} in ${s.text.slice(0, 40)}`);
      assert.doesNotMatch(s.text, new RegExp(`\\$${s.params.length + 1}\\b`));
    }
  });
});

const SAVE = {
  studentId: STUDENT,
  readingId: READING,
  claimId: "c1",
  attemptId: "a1",
  passed: false,
  verdicts: [
    { questionId: "q1", text: "to see the snow", pass: true, nudge: "" },
    { questionId: "q2", text: "idk", pass: false, nudge: "Look at what the fox did." },
  ],
};

describe("claimOutcome", () => {
  const diag = (row: Record<string, unknown>) => [[{}], [], [row]];
  const base = { eligible: true, passed: false, tries: 0, live: false, checks: 0 };

  it("reads a claim, then each reason in order", () => {
    assert.equal(claimOutcome([[{}], [{ id: "c1" }], [base]]), "claimed");
    assert.equal(claimOutcome(diag({ ...base, eligible: false, passed: true })), "not_found");
    assert.equal(claimOutcome(diag({ ...base, passed: true, live: true })), "already_passed");
    assert.equal(claimOutcome(diag({ ...base, tries: 3, live: true })), "out_of_tries");
    assert.equal(claimOutcome(diag({ ...base, live: true, checks: 6 })), "busy");
    assert.equal(claimOutcome(diag({ ...base, checks: 6 })), "too_many_checks");
    assert.equal(claimOutcome(diag(base)), "busy");
    assert.equal(claimOutcome([]), "not_found");
  });
});

describe("commit statements", () => {
  const statements = commitStatements(SAVE);

  it("take the same lock as the claim", () => {
    assert.deepEqual(statements[0], claimStatements(STUDENT, READING, "x")[0]);
  });

  it("finish the claim and insert the next try, only while the claim is live and tries remain", () => {
    const s = statements[1];
    assert.match(s.text, /with claim as \(\s*update effort_checks set finished_at = now\(\), outcome = \$5::text/);
    assert.match(s.text, /finished_at is null and created_at > now\(\) - make_interval\(secs => \$6::int\)/);
    assert.match(s.text, /reading_id = \$2::uuid\) < \$7::int/);
    assert.match(s.text, /insert into attempts \(id, student_id, reading_id, try_number, result\)/);
    assert.match(s.text, /reading_id = \$2::uuid\) \+ 1, \$5::text::attempt_result\s+from claim/);
    assert.deepEqual(s.params, [STUDENT, READING, "c1", "a1", "fail", EFFORT_CLAIM_STALE_SECONDS, MAX_TRIES]);
    assert.equal(commitStatements({ ...SAVE, passed: true })[1].params[4], "pass");
  });

  it("insert the answers for the saved try and this student's questions only", () => {
    const s = statements[2];
    assert.match(s.text, /insert into answers \(attempt_id, question_id, text, ai_pass, ai_feedback\)/);
    assert.match(s.text, /nullif\(a\.nudge, ''\)/);
    assert.match(s.text, /q\.reading_id = \$2::uuid\s+and \(q\.student_id is null or q\.student_id = \$1::uuid\)/);
    assert.match(s.text, /where exists \(select 1 from attempts where id = \$3::uuid\)/);
    assert.deepEqual(s.params, [
      STUDENT,
      READING,
      "a1",
      ["q1", "q2"],
      ["to see the snow", "idk"],
      [true, false],
      ["", "Look at what the fox did."],
    ]);
  });

  it("read the saved try number, or null when the claim was lost", () => {
    assert.equal(committedTry([[{}], [{ try_number: 2 }], [{}, {}]]), 2);
    assert.equal(committedTry([[{}], [], []]), null);
  });
});

describe("submitLookup", () => {
  it("reads the reading, the questions, and the tries", () => {
    const lookup = submitLookup([
      [{ body_text: "text", grade_level: "5", question_mode: "shared" }],
      [{ id: "q1", position: 1, prompt: "Why?" }],
      [{ tries: 2, passed: false }],
    ]);
    assert.deepEqual(lookup, {
      status: "ok",
      context: { bodyText: "text", gradeLevel: "5", questions: [{ id: "q1", position: 1, prompt: "Why?" }], tries: 2, passed: false },
    });
    assert.deepEqual(submitLookup([[], [], []]), { status: "not_found" });
  });

  it("uses the reading's grade over the class's, and the student's own set in per-student mode", () => {
    const [reading, questions] = submitContextStatements(STUDENT, READING);
    assert.match(reading.text, /coalesce\(r\.grade_level, c\.grade_level\) as grade_level/);
    assert.match(reading.text, /join students s on s\.class_id = r\.class_id and s\.id = \$1::uuid/);
    assert.match(questions.text, /q\.student_id is not distinct from \(\s*case when r\.question_mode = 'per_student' then \$1::uuid end/);
  });
});

describe("postgresAttemptStore", () => {
  function fakeExecutor(responses: Record<string, unknown>[][][]) {
    const calls: Statement[][] = [];
    const execute = async (statements: Statement[]) => {
      calls.push(statements);
      return responses.shift() ?? [];
    };
    return { execute, calls };
  }

  it("runs each step as one batch", async () => {
    const { execute, calls } = fakeExecutor([
      [[{ body_text: "t", grade_level: "4" }], QUESTIONS, [{ tries: 0, passed: false }]],
      [[{}], [{ id: "c1" }], [{}]],
      [[{}], [{ try_number: 1 }], [{}, {}]],
    ]);
    const store = postgresAttemptStore(execute);
    const lookup = await store.loadContext(STUDENT, READING);
    assert.equal(lookup.status, "ok");
    assert.equal(await store.claim(STUDENT, READING, "c1"), "claimed");
    assert.equal(await store.commit(SAVE), 1);
    assert.deepEqual(calls.map((c) => c.length), [3, 3, 3]);
  });

  it("propagates executor errors (fail closed)", async () => {
    const store = postgresAttemptStore(async () => {
      throw new Error("db down");
    });
    await assert.rejects(store.claim(STUDENT, READING, "c1"), /db down/);
    await assert.rejects(store.release(STUDENT, READING, "c1"), /db down/);
  });

  it("releases with outcome error, only an unfinished claim", () => {
    const s = releaseStatement(STUDENT, READING, "c1");
    assert.match(s.text, /set finished_at = now\(\), outcome = 'error'/);
    assert.match(s.text, /finished_at is null/);
  });
});
