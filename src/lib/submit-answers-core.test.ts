import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { EFFORT_CHECK_DEADLINE_MS } from "./ai/settings";
import { checkEffort, EffortCheckError, type EffortCheckInput, type EffortVerdict } from "./ai/effort-check";
import type { ModelReply } from "./ai/model";
import { QuestionWriterError, type QuestionModel } from "./ai/questions";
import { DeadlineError } from "./deadline";
import type { Statement } from "./link-rate-limit";
import {
  ALREADY_PASSED_MESSAGE,
  CHECK_BUSY_MESSAGE,
  CHECK_FAILED_MESSAGE,
  CHECK_TIMED_OUT_MESSAGE,
  CHECKS_PAUSED_MESSAGE,
  claimOutcome,
  claimStatements,
  commitStatements,
  committedTry,
  EFFORT_CHECK_LIMIT,
  EFFORT_CLAIM_STALE_SECONDS,
  EFFORT_GIVEN_BACK_WINDOW_LIMIT,
  EFFORT_GIVEN_BACK_WINDOW_MINUTES,
  effortFailureCounts,
  refreshesPage,
  OUT_OF_TRIES_MESSAGE,
  pausedUntilStatement,
  postgresAttemptStore,
  releaseStatement,
  submitAnswersWith,
  submitContextStatements,
  submitLookup,
  submitMessage,
  TOO_MANY_CHECKS_MESSAGE,
  type AttemptStore,
  type EffortChecker,
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
  // A teacher's one more try moves these (see grantExtraTry below).
  const limits = { tries: MAX_TRIES, checks: EFFORT_CHECK_LIMIT };
  const attempts: Attempt[] = [];
  let now = 0;
  const live = () => checks.some((c) => !c.finished && now - c.createdAt < EFFORT_CLAIM_STALE_SECONDS);
  const passed = () => attempts.some((a) => a.passed);
  // Locked: passed on the latest try.
  const locked = () => (attempts.at(-1)?.answers ?? []).filter((a) => a.pass);
  // Given-back checks don't count toward the limit, only the window.
  const counted = () => checks.filter((c) => c.outcome !== "given_back").length;
  const givenBackRecent = () =>
    checks.filter((c) => c.outcome === "given_back" && now - c.createdAt < EFFORT_GIVEN_BACK_WINDOW_MINUTES * 60);
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
          lockedQuestionIds: locked().map((a) => a.questionId),
          tries: attempts.length,
          triesAllowed: limits.tries,
          passed: passed(),
        },
      };
    },
    async claim(_s, _r, claimId, expectedTries) {
      await tick();
      if (options.eligible === false) return "not_found";
      if (passed()) return "already_passed";
      if (attempts.length >= limits.tries) return "out_of_tries";
      if (live()) return "busy";
      if (attempts.length !== expectedTries) return "stale";
      if (counted() >= limits.checks) return "too_many_checks";
      if (givenBackRecent().length >= EFFORT_GIVEN_BACK_WINDOW_LIMIT) return "paused";
      checks.push({ id: claimId, createdAt: now, finished: false, outcome: null });
      return "claimed";
    },
    async release(_s, _r, claimId, givenBack) {
      await tick();
      const c = checks.find((x) => x.id === claimId);
      if (c && !c.finished) Object.assign(c, { finished: true, outcome: givenBack ? "given_back" : "error" });
    },
    async pausedUntil() {
      const oldest = Math.min(...givenBackRecent().map((c) => c.createdAt));
      return new Date((oldest + EFFORT_GIVEN_BACK_WINDOW_MINUTES * 60) * 1000);
    },
    async commit(input) {
      await tick();
      const c = checks.find((x) => x.id === input.claimId);
      if (!c || c.finished || now - c.createdAt >= EFFORT_CLAIM_STALE_SECONDS) return null;
      if (attempts.length >= limits.tries || passed()) return null;
      Object.assign(c, { finished: true, outcome: input.passed ? "pass" : "fail" });
      const tryNumber = attempts.length + 1;
      // The locked answers first, then the new ones, never over a locked
      // one (on conflict do nothing).
      const carried = locked();
      const fresh = input.verdicts.filter((v) => !carried.some((c) => c.questionId === v.questionId));
      attempts.push({ tryNumber, passed: input.passed, answers: [...carried.map((c) => ({ ...c, nudge: "" })), ...fresh] });
      return tryNumber;
    },
  };
  // Deny with one more try (see reading-limits.ts): exactly 1 try left.
  const grantExtraTry = () => Object.assign(limits, { tries: attempts.length + 1, checks: counted() + 2 });
  return { store, checks, attempts, grantExtraTry, advance: (s: number) => void (now += s) };
}

// Fake effort checker: passes everything unless told otherwise, takes a
// moment like a real call, and counts calls.
// With `replied`, a thrown error comes after the model replied (like a
// 5xx on the retry after an unusable reply), reported through the hook.
function fakeChecker(verdict: (input: EffortCheckInput) => EffortVerdict[] | Error = passAll, delayMs = 5, replied = false) {
  let calls = 0;
  const check: EffortChecker = async (input, hooks) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const out = verdict(input);
    if (out instanceof Error) {
      if (replied) hooks?.onModelResponse();
      throw out;
    }
    return out;
  };
  return { check, calls: () => calls };
}

// A reply came back but wasn't usable: counts toward the limit.
const badOutput = () => new EffortCheckError("failed", "invalid output: expected exactly 2 results");

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

// Nothing passes, so nothing is locked and every try sends every answer.
function failAll(input: EffortCheckInput): EffortVerdict[] {
  return input.items.map((i) => ({ questionId: i.questionId, pass: false, nudge: "Say more." }));
}

let ids = 0;
const newId = () => `id${++ids}`;

function submit(store: AttemptStore, check: EffortChecker, entries = ANSWERS) {
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
    const checker = fakeChecker(failAll);
    for (let i = 1; i <= MAX_TRIES; i++) {
      const r = await submit(store, checker.check);
      assert.equal(r.status === "checked" && r.tryNumber, i);
    }
    assert.deepEqual(await submit(store, checker.check), { status: "out_of_tries" });
    assert.equal(checker.calls(), MAX_TRIES);
    assert.equal(attempts.length, MAX_TRIES);
  });

  it("after one more try from the teacher, checks exactly one more try, then refuses", async () => {
    const { store, attempts, grantExtraTry } = fakeStore();
    const checker = fakeChecker(failAll);
    for (let i = 1; i <= MAX_TRIES; i++) await submit(store, checker.check);
    grantExtraTry();
    const extra = await submit(store, checker.check);
    assert.equal(extra.status === "checked" && extra.tryNumber, MAX_TRIES + 1);
    assert.deepEqual(await submit(store, checker.check), { status: "out_of_tries" });
    assert.equal(attempts.length, MAX_TRIES + 1);
    assert.equal(checker.calls(), MAX_TRIES + 1);
  });

  it("one more try at the check limit: a model failure keeps the try, the 2nd failure ends it", async () => {
    const { store, attempts, checks, grantExtraTry } = fakeStore();
    const broken = fakeChecker(badOutput);
    for (let i = 0; i < EFFORT_CHECK_LIMIT; i++) await submit(store, broken.check);
    assert.deepEqual(await submit(store, broken.check), { status: "too_many_checks" });
    grantExtraTry();
    assert.deepEqual(await submit(store, broken.check), { status: "check_failed" });
    assert.deepEqual(await submit(store, broken.check), { status: "check_failed" });
    assert.deepEqual(await submit(store, broken.check), { status: "too_many_checks" });
    assert.equal(checks.length, EFFORT_CHECK_LIMIT + 2);
    assert.equal(attempts.length, 0);
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

  describe("passed answers are locked", () => {
    const THREE = [...QUESTIONS, { id: "q3", position: 3, prompt: "Where did they go?" }];
    const all = [...ANSWERS, { questionId: "q3", value: "home" }];
    const rest = all.slice(1);
    // Passes q1 only.
    const firstOnly = (input: EffortCheckInput) =>
      input.items.map((i) => ({ questionId: i.questionId, pass: i.questionId === "q1", nudge: i.questionId === "q1" ? "" : "Say more." }));

    it("pass q1 on try 1: try 2 checks only q2 and q3, and q1 stays as it was", async () => {
      const { store, attempts, checks } = fakeStore({ questions: THREE });
      const seen: string[][] = [];
      const checker = fakeChecker((input) => {
        seen.push(input.items.map((i) => i.questionId));
        return seen.length === 1 ? firstOnly(input) : passAll(input);
      });
      const one = await submit(store, checker.check, all);
      assert.equal(one.status === "checked" && one.passed, false);
      const two = await submit(store, checker.check, rest);
      assert.deepEqual(two, {
        status: "checked",
        passed: true,
        tryNumber: 2,
        results: [
          { questionId: "q2", pass: true, nudge: "" },
          { questionId: "q3", pass: true, nudge: "" },
        ],
      });
      assert.deepEqual(seen, [["q1", "q2", "q3"], ["q2", "q3"]]);
      // Every try holds every question; q1 carried over as it was.
      assert.deepEqual(
        attempts[1].answers.map((a) => [a.questionId, a.text, a.pass]),
        [["q1", "to see the snow", true], ["q2", "it ran away", true], ["q3", "home", true]],
      );
      assert.equal(attempts[1].passed, true);
      // One check per try, no more.
      assert.deepEqual(checks.map((c) => c.outcome), ["fail", "pass"]);
    });

    it("a crafted answer for a locked question is refused before any claim or model call", async () => {
      const { store, attempts, checks } = fakeStore({ questions: THREE });
      const checker = fakeChecker(firstOnly);
      await submit(store, checker.check, all);
      const crafted = [{ questionId: "q1", value: "changed" }, ...rest];
      assert.deepEqual(await submit(store, checker.check, crafted), { status: "stale" });
      assert.equal(checker.calls(), 1);
      assert.equal(checks.length, 1);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].answers[0].text, "to see the snow");
    });

    it("the try passes once the open questions pass; failing ones stay open across tries", async () => {
      const { store, attempts } = fakeStore({ questions: THREE });
      const seen: string[][] = [];
      // Try 1: q1 passes. Try 2: q2 passes, q3 doesn't. Try 3: q3 passes.
      const plan = [firstOnly, (i: EffortCheckInput) => i.items.map((x) => ({ questionId: x.questionId, pass: x.questionId === "q2", nudge: x.questionId === "q2" ? "" : "Where?" })), passAll];
      const checker = fakeChecker((input) => {
        seen.push(input.items.map((i) => i.questionId));
        return plan[seen.length - 1](input);
      });
      await submit(store, checker.check, all);
      await submit(store, checker.check, rest);
      const three = await submit(store, checker.check, rest.slice(1));
      assert.equal(three.status === "checked" && three.passed, true);
      assert.deepEqual(seen, [["q1", "q2", "q3"], ["q2", "q3"], ["q3"]]);
      assert.deepEqual(attempts.map((a) => a.passed), [false, false, true]);
      assert.deepEqual(attempts[1].answers.map((a) => a.pass), [true, true, false]);
    });

    it("a failed check keeps the lock and the try, and counts only when the model replied", async () => {
      const { store, attempts, checks } = fakeStore({ questions: THREE });
      await submit(store, fakeChecker(firstOnly).check, all);
      assert.deepEqual(await submit(store, fakeChecker(() => new QuestionWriterError("not_configured", "402")).check, rest), { status: "check_failed" });
      assert.deepEqual(await submit(store, fakeChecker(badOutput).check, rest), { status: "check_failed" });
      assert.deepEqual(checks.map((c) => c.outcome), ["fail", "given_back", "error"]);
      assert.equal(attempts.length, 1);
      const seen: string[][] = [];
      const ok = await submit(store, fakeChecker((input) => (seen.push(input.items.map((i) => i.questionId)), passAll(input))).check, rest);
      assert.equal(ok.status === "checked" && ok.tryNumber, 2);
      assert.deepEqual(seen, [["q2", "q3"]]);
    });

    it("an old tab's answers after another tab saved a try are stale at the claim", async () => {
      const { store, attempts } = fakeStore({ questions: THREE });
      const slow = fakeChecker(firstOnly, 1);
      // Tab A loads (0 tries) while tab B's check runs and saves try 1.
      const b = submit(store, slow.check, all);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await b;
      const loadA = store.loadContext;
      let first = true;
      store.loadContext = async (s, r) => {
        const lookup = await loadA(s, r);
        if (first && lookup.status === "ok") {
          first = false;
          return { status: "ok", context: { ...lookup.context, tries: 0, lockedQuestionIds: [] } };
        }
        return lookup;
      };
      assert.deepEqual(await submit(store, slow.check, all), { status: "stale" });
      assert.equal(attempts.length, 1);
      assert.equal(slow.calls(), 1);
    });
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
    const checker = fakeChecker(failAll, 2);
    for (let wave = 0; wave < 6; wave++) {
      await Promise.all(Array.from({ length: 20 }, () => submit(store, checker.check)));
    }
    assert.equal(attempts.length, MAX_TRIES);
    assert.deepEqual(attempts.map((a) => a.tryNumber), [1, 2, 3]);
    assert.ok(checks.length <= EFFORT_CHECK_LIMIT);
    assert.equal(checker.calls(), checks.length);
  });

  it("a failure after a model reply doesn't use a try but counts toward the limit", async () => {
    const { store, attempts, checks } = fakeStore();
    const errors: unknown[] = [];
    const failing = fakeChecker(() => new Error("500 on the retry"), 5, true);
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

  it("stops at EFFORT_CHECK_LIMIT checks, failures the model replied to included", async () => {
    const { store, checks } = fakeStore();
    const failing = fakeChecker(badOutput);
    for (let i = 0; i < EFFORT_CHECK_LIMIT; i++) {
      assert.deepEqual(await submit(store, failing.check), { status: "check_failed" });
    }
    const working = fakeChecker();
    assert.deepEqual(await submit(store, working.check), { status: "too_many_checks" });
    assert.equal(working.calls(), 0);
    assert.equal(failing.calls(), EFFORT_CHECK_LIMIT);
    assert.equal(checks.length, EFFORT_CHECK_LIMIT);
  });

  it("treats wrong verdicts from the checker as a failed check (counted: a reply came back)", async () => {
    const { store, attempts, checks } = fakeStore();
    const r = await submit(store, fakeChecker((input) => passAll(input).slice(0, 1)).check);
    assert.deepEqual(r, { status: "check_failed" });
    assert.equal(attempts.length, 0);
    assert.equal(checks[0].outcome, "error");
  });

  it("a model call that hangs past the deadline is timed_out: no try used, the check given back", async () => {
    const { store, attempts, checks } = fakeStore();
    // AbortSignal.timeout's timer doesn't hold the event loop open (see
    // effort-check.test.ts).
    const keepAlive = setInterval(() => {}, 1_000);
    try {
      // The real checker over a call that never settles and ignores its
      // signal (a stuck request, or a stuck gateway token lookup).
      const hanging: QuestionModel = { model: "m", create: () => new Promise<ModelReply>(() => {}) };
      const errors: unknown[] = [];
      const r = await submitAnswersWith(STUDENT, READING, ANSWERS, {
        store,
        check: (input, hooks) => checkEffort(hanging, input, { deadlineMs: 20, onModelResponse: hooks?.onModelResponse }),
        newId,
        onError: (e) => errors.push(e),
      });
      assert.deepEqual(r, { status: "timed_out", counted: false });
      assert.equal(errors.length, 1, "logged once");
    } finally {
      clearInterval(keepAlive);
    }
    assert.equal(attempts.length, 0, "no try saved");
    assert.deepEqual(checks.map((c) => [c.finished, c.outcome]), [[true, "given_back"]]);
    // The next check is still try 1 of 3, right away.
    const next = await submit(store, fakeChecker().check);
    assert.equal(next.status === "checked" && next.tryNumber, 1);
  });

  it("a timeout after an unusable reply is timed_out too, and counts as a check (counted: true)", async () => {
    const { store, attempts, checks } = fakeStore();
    const deadline = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const r = await submit(store, fakeChecker(() => deadline, 5, true).check);
    assert.deepEqual(r, { status: "timed_out", counted: true });
    assert.equal(attempts.length, 0);
    assert.equal(checks[0].outcome, "error");
  });

  it("a counted timeout can be the last check: the page must move on (the action re-renders)", async () => {
    const { store, attempts } = fakeStore();
    for (let i = 0; i < EFFORT_CHECK_LIMIT - 1; i++) {
      assert.equal((await submit(store, fakeChecker(badOutput).check)).status, "check_failed");
    }
    const deadline = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const last = await submit(store, fakeChecker(() => deadline, 5, true).check);
    assert.deepEqual(last, { status: "timed_out", counted: true });
    // That was the limit: the answer form would be stale, so the action
    // refreshes on `counted`, and the next submit is refused.
    assert.equal((await submit(store, fakeChecker().check)).status, "too_many_checks");
    assert.equal(attempts.length, 0);
  });

  it("a plain failure is still check_failed, not timed_out", async () => {
    const { store } = fakeStore();
    assert.deepEqual(await submit(store, fakeChecker(() => new Error("fetch failed")).check), { status: "check_failed" });
  });

  it("a lookup that fails before the claim propagates, with no check claimed and no try saved", async () => {
    const { store, attempts, checks } = fakeStore();
    const down = new Error("fetch failed");
    store.loadContext = async () => {
      throw down;
    };
    const checker = fakeChecker();
    await assert.rejects(submit(store, checker.check), (e: unknown) => e === down);
    assert.equal(checks.length, 0, "no effort_checks row");
    assert.equal(attempts.length, 0);
    assert.equal(checker.calls(), 0);
  });

  it("a lookup that hangs past the pre-check deadline is a DeadlineError, with nothing written", async () => {
    const { store, attempts, checks } = fakeStore();
    store.loadContext = () => new Promise(() => {});
    const checker = fakeChecker();
    const preCheck = new AbortController();
    const r = submitAnswersWith(STUDENT, READING, ANSWERS, { store, check: checker.check, newId, preCheck: preCheck.signal });
    preCheck.abort();
    await assert.rejects(r, DeadlineError);
    assert.equal(checks.length, 0, "no effort_checks row");
    assert.equal(attempts.length, 0);
    assert.equal(checker.calls(), 0);
  });

  it("the pre-check deadline ends at the claim: a slow check after it still saves the try", async () => {
    const { store, attempts } = fakeStore();
    const preCheck = new AbortController();
    const checker = fakeChecker();
    const slow: EffortChecker = async (input, hooks) => {
      // Past the pre-check deadline, mid check.
      preCheck.abort();
      return checker.check(input, hooks);
    };
    const r = await submitAnswersWith(STUDENT, READING, ANSWERS, { store, check: slow, newId, preCheck: preCheck.signal });
    assert.equal(r.status === "checked" && r.tryNumber, 1);
    assert.equal(attempts.length, 1);
  });

  it("a failure with no model reply is given back: never toward the limit, only the short window", async () => {
    const { store, attempts, checks, advance } = fakeStore();
    // Not set up (no credentials), out of credits (402 maps to
    // not_configured), busy, an outage, a timeout: no reply in any.
    const noReply = [
      new QuestionWriterError("not_configured", "no AI Gateway API key or OIDC token"),
      new QuestionWriterError("not_configured", "402"),
      new Error("fetch failed"),
    ];
    for (const error of noReply) {
      assert.deepEqual(await submit(store, fakeChecker(() => error).check), { status: "check_failed" });
    }
    assert.deepEqual(
      checks.map((c) => c.outcome),
      ["given_back", "given_back", "given_back"],
    );
    // The window is full: paused, with when it frees up, and no model call.
    const working = fakeChecker();
    const paused = await submit(store, working.check);
    assert.deepEqual(paused, { status: "paused", retryAt: new Date(EFFORT_GIVEN_BACK_WINDOW_MINUTES * 60 * 1000) });
    assert.equal(working.calls(), 0);
    assert.equal(submitMessage("paused"), CHECKS_PAUSED_MESSAGE);
    // After the window, checking works again, and all 6 checks are left.
    advance(EFFORT_GIVEN_BACK_WINDOW_MINUTES * 60);
    for (let i = 0; i < EFFORT_CHECK_LIMIT; i++) {
      advance(EFFORT_GIVEN_BACK_WINDOW_MINUTES * 60);
      assert.deepEqual(await submit(store, fakeChecker(() => new Error("timeout")).check), { status: "check_failed" });
    }
    assert.equal(attempts.length, 0);
    const after = await submit(store, fakeChecker(failSecond).check);
    assert.equal(after.status === "checked" && after.tryNumber, 1, "given-back checks never reach the limit");
  });

  it("effortFailureCounts: only a reply (or unusable output) counts", () => {
    assert.equal(effortFailureCounts(new Error("fetch failed"), false), false);
    assert.equal(effortFailureCounts(new QuestionWriterError("not_configured", "402"), false), false);
    assert.equal(effortFailureCounts(new EffortCheckError("timeout", "deadline"), false), false);
    assert.equal(effortFailureCounts(new Error("fetch failed"), true), true);
    assert.equal(effortFailureCounts(badOutput(), false), true);
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

  it("releases the claim when the commit throws another database error, then fails closed", async () => {
    const { store, checks, attempts } = fakeStore();
    const errors: unknown[] = [];
    const broken: AttemptStore = { ...store, commit: async () => Promise.reject(new Error("connection reset")) };
    await assert.rejects(
      submitAnswersWith(STUDENT, READING, ANSWERS, { store: broken, check: fakeChecker().check, newId, onError: (e) => errors.push(e) }),
      /connection reset/,
    );
    // Finished at once (no 90s of "busy"), still counted, no try used.
    assert.equal(checks.length, 1);
    assert.deepEqual([checks[0].finished, checks[0].outcome], [true, "error"]);
    assert.equal(attempts.length, 0);
    // The action logs the thrown error; nothing extra here.
    assert.equal(errors.length, 0);
    const next = await submit(store, fakeChecker().check);
    assert.equal(next.status === "checked" && next.tryNumber, 1);
  });

  it("keeps a commit that landed before the error (the release only touches an unfinished claim)", async () => {
    const { store, checks, attempts } = fakeStore();
    const landed: AttemptStore = {
      ...store,
      commit: async (input) => {
        await store.commit(input);
        throw new Error("network error after commit");
      },
    };
    await assert.rejects(submit(landed, fakeChecker().check), /network error after commit/);
    assert.equal(attempts.length, 1);
    assert.equal(checks[0].outcome, "pass");
  });

  it("still fails closed with the commit's error when the release fails too", async () => {
    const { store, checks } = fakeStore();
    const errors: unknown[] = [];
    const broken: AttemptStore = {
      ...store,
      commit: async () => Promise.reject(new Error("db down")),
      release: async () => Promise.reject(new Error("release failed")),
    };
    await assert.rejects(
      submitAnswersWith(STUDENT, READING, ANSWERS, { store: broken, check: fakeChecker().check, newId, onError: (e) => errors.push(e) }),
      /db down/,
    );
    assert.deepEqual(errors.map((e) => (e as Error).message), ["release failed"]);
    // Left unfinished: it goes stale on its own, and still counts.
    assert.equal(checks[0].finished, false);
  });

  it("a commit-time conflict still reports a failed check when the release fails", async () => {
    const { store } = fakeStore();
    const conflicted: AttemptStore = {
      ...store,
      commit: async () => Promise.reject(Object.assign(new Error("dup"), { code: "23505" })),
      release: async () => Promise.reject(new Error("release failed")),
    };
    assert.deepEqual(await submit(conflicted, fakeChecker().check), { status: "check_failed" });
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

describe("refreshesPage", () => {
  it("re-renders after a saved try, a counted timeout, and whenever the page may have moved on", () => {
    const yes: SubmitResult[] = [
      { status: "checked", passed: false, tryNumber: 1, results: [] },
      { status: "already_passed" },
      { status: "out_of_tries" },
      { status: "too_many_checks" },
      { status: "check_failed" },
      // A reply, then a retry that ran out of time: it counted, and may
      // have been the last check (the page shows the note to the teacher).
      { status: "timed_out", counted: true },
    ];
    for (const result of yes) assert.equal(refreshesPage(result), true, result.status);
  });

  it("skips the re-render when nothing changed", () => {
    const no: SubmitResult[] = [
      { status: "timed_out", counted: false },
      { status: "invalid", errors: {} },
      { status: "stale" },
      { status: "not_found" },
      { status: "busy" },
      { status: "paused", retryAt: null },
    ];
    for (const result of no) assert.equal(refreshesPage(result), false, result.status);
  });

  it("is what both answer actions use to revalidate", () => {
    for (const actions of ["src/app/c/r/[readingId]/actions.ts", "src/app/learn/r/[readingId]/actions.ts"]) {
      const source = readFileSync(actions, "utf8");
      assert.match(source, /if \(refreshesPage\(result\)\)/, actions);
      assert.doesNotMatch(source, /result\.counted/, `${actions}: no second copy of the branch`);
    }
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
    assert.equal(submitMessage("timed_out"), CHECK_TIMED_OUT_MESSAGE);
    assert.equal(submitMessage("stale"), ANSWERS_STALE_MESSAGE);
    const all = [ALREADY_PASSED_MESSAGE, OUT_OF_TRIES_MESSAGE, CHECK_BUSY_MESSAGE, TOO_MANY_CHECKS_MESSAGE, CHECK_FAILED_MESSAGE, CHECK_TIMED_OUT_MESSAGE];
    assert.equal(new Set(all).size, all.length);
    assert.match(TOO_MANY_CHECKS_MESSAGE, /Send a note to your teacher/);
    assert.match(CHECK_FAILED_MESSAGE, /Wait a minute, then try again\. This didn’t use up a try\./);
    assert.equal(CHECK_TIMED_OUT_MESSAGE, "That took too long. Try again. This didn’t use up a try.");
  });
});

describe("claim statements", () => {
  const statements = claimStatements(STUDENT, READING, "c1", 0);

  it("lock (student, reading) in their own advisory lock space", () => {
    assert.match(statements[0].text, /pg_advisory_xact_lock\(\$1::int, hashtext\(\$2::text\)\)/);
    assert.deepEqual(statements[0].params, [3, `${STUDENT}:${READING}`]);
  });

  it("insert only when eligible, not passed, under the try limit, no live claim, under the check limit", () => {
    const insert = statements[1];
    assert.match(insert.text, /insert into effort_checks \(id, student_id, reading_id\)/);
    assert.match(insert.text, /r\.status = 'published'/);
    assert.match(insert.text, /not exists \(\s*select 1 from attempts[\s\S]*result = 'pass'/);
    // The limits: the latest teacher grant, else MAX_TRIES and
    // EFFORT_CHECK_LIMIT.
    assert.match(
      insert.text,
      new RegExp(`from attempts where student_id = \\$1::uuid and reading_id = \\$2::uuid\\) < coalesce\\(\\(select g\\.tries_allowed from challenges g[\\s\\S]*?order by g\\.round desc limit 1\\), ${MAX_TRIES}\\)`),
    );
    assert.match(insert.text, /and not exists \(\s*select 1 from effort_checks[\s\S]*finished_at is null and created_at > now\(\) - make_interval\(secs => \$4::int\)/);
    assert.match(
      insert.text,
      new RegExp(`from effort_checks where student_id = \\$1::uuid and reading_id = \\$2::uuid and outcome is distinct from 'given_back'\\) < coalesce\\(\\(select g\\.checks_allowed from challenges g[\\s\\S]*?limit 1\\), ${EFFORT_CHECK_LIMIT}\\)`),
    );
    // At most 3 given-back checks in 10 minutes.
    assert.match(insert.text, /outcome = 'given_back'\n    and created_at > now\(\) - make_interval\(mins => \$5::int\)\) < \$6::int/);
    // Still exactly the tries the answers were validated against.
    assert.match(insert.text, /reading_id = \$2::uuid\) = \$7::int/);
    assert.deepEqual(insert.params, [STUDENT, READING, "c1", EFFORT_CLAIM_STALE_SECONDS, EFFORT_GIVEN_BACK_WINDOW_MINUTES, EFFORT_GIVEN_BACK_WINDOW_LIMIT, 0]);
    assert.equal(claimStatements(STUDENT, READING, "c1", 2)[1].params[6], 2);
  });

  it("lowercase the lock key, so an uppercase id from the URL shares the lock", () => {
    const upper = claimStatements("S1", "AB-CD", "c1", 0)[0];
    assert.deepEqual(upper.params, [3, "s1:ab-cd"]);
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
  const base = { eligible: true, passed: false, tries: 0, live: false, checks: 0, tries_allowed: 3, checks_allowed: 6 };

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

  it("a try saved since the answers were validated is stale (after a running check, before the limits)", () => {
    assert.equal(claimOutcome(diag({ ...base, tries: 1 }), 0), "stale");
    assert.equal(claimOutcome(diag({ ...base, tries: 1, checks: 6 }), 0), "stale");
    assert.equal(claimOutcome(diag({ ...base, tries: 1, live: true }), 0), "busy");
    assert.equal(claimOutcome(diag({ ...base, tries: 1 }), 1), "busy");
    assert.equal(claimOutcome([[{}], [{ id: "c1" }], [base]], 0), "claimed");
  });

  it("uses the student's own limits after one more try", () => {
    const granted = { ...base, tries: 3, checks: 6, tries_allowed: 4, checks_allowed: 8 };
    assert.equal(claimOutcome(diag(granted)), "busy");
    assert.equal(claimOutcome(diag({ ...granted, tries: 4 })), "out_of_tries");
    assert.equal(claimOutcome(diag({ ...granted, checks: 8 })), "too_many_checks");
    // Missing limits fall back to the defaults.
    assert.equal(claimOutcome(diag({ eligible: true, passed: false, tries: 3, live: false, checks: 3 })), "out_of_tries");
  });
});

describe("commit statements", () => {
  const statements = commitStatements(SAVE);

  it("take the same lock as the claim", () => {
    assert.deepEqual(statements[0], claimStatements(STUDENT, READING, "x", 0)[0]);
  });

  it("finish the claim and insert the next try, only while the claim is live and tries remain", () => {
    const s = statements[1];
    assert.match(s.text, /with claim as \(\s*update effort_checks set finished_at = now\(\), outcome = \$5::text/);
    assert.match(s.text, /finished_at is null and created_at > now\(\) - make_interval\(secs => \$6::int\)/);
    assert.match(s.text, /reading_id = \$2::uuid\) < coalesce\(\(select g\.tries_allowed from challenges g/);
    assert.match(s.text, /insert into attempts \(id, student_id, reading_id, try_number, result\)/);
    assert.match(s.text, /reading_id = \$2::uuid\) \+ 1, \$5::text::attempt_result\s+from claim/);
    assert.deepEqual(s.params, [STUDENT, READING, "c1", "a1", "fail", EFFORT_CLAIM_STALE_SECONDS]);
    assert.equal(commitStatements({ ...SAVE, passed: true })[1].params[4], "pass");
  });

  it("copy the locked answers of the previous try into the saved one, as they were", () => {
    const s = statements[2];
    assert.match(s.text, /^insert into answers \(attempt_id, question_id, text, ai_pass, ai_feedback\)\nselect \$3::uuid, p\.question_id, p\.text, true, null/);
    assert.match(s.text, /where p\.ai_pass and p\.attempt_id = \(\s*select a\.id from attempts a\s*where a\.student_id = \$1::uuid and a\.reading_id = \$2::uuid and a\.id <> \$3::uuid\s*order by a\.try_number desc limit 1/);
    assert.match(s.text, /exists \(select 1 from attempts where id = \$3::uuid and student_id = \$1::uuid and reading_id = \$2::uuid\)/);
    assert.deepEqual(s.params, [STUDENT, READING, "a1"]);
  });

  it("insert the answers for the saved try and this student's questions only, never over a locked one", () => {
    const s = statements[3];
    assert.match(s.text, /on conflict \(attempt_id, question_id\) do nothing/);
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

  it("close an open challenge, only when the try just saved passed", () => {
    const s = statements[4];
    assert.match(s.text, /^update challenges set status = 'closed', resolved_at = now\(\)/);
    assert.match(s.text, /where student_id = \$1::uuid and reading_id = \$2::uuid and status = 'open'/);
    assert.match(s.text, /where id = \$3::uuid and student_id = \$1::uuid and reading_id = \$2::uuid and result = 'pass'/);
    assert.deepEqual(s.params, [STUDENT, READING, "a1"]);
    assert.equal(statements.length, 5);
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
      [{ tries: 2, passed: false, tries_allowed: 3 }],
      [{ question_id: "q1" }],
    ]);
    assert.deepEqual(lookup, {
      status: "ok",
      context: {
        bodyText: "text",
        gradeLevel: "5",
        questions: [{ id: "q1", position: 1, prompt: "Why?" }],
        lockedQuestionIds: ["q1"],
        tries: 2,
        triesAllowed: 3,
        passed: false,
      },
    });
    const granted = submitLookup([[{ body_text: "t", grade_level: "5" }], [], [{ tries: 3, passed: false, tries_allowed: 4 }]]);
    assert.equal(granted.status === "ok" && granted.context.triesAllowed, 4);
    assert.deepEqual(submitLookup([[], [], []]), { status: "not_found" });
  });

  it("uses the reading's grade over the class's, and the student's own set in per-student mode", () => {
    const [reading, questions, , locked] = submitContextStatements(STUDENT, READING);
    // Locked: the passing answers of the latest try.
    assert.match(locked.text, /^select an\.question_id from answers an\nwhere an\.ai_pass and an\.attempt_id = \(\s*select a\.id from attempts a\s*where a\.student_id = \$1::uuid and a\.reading_id = \$2::uuid\s*order by a\.try_number desc limit 1/);
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
      [[{}], [{ try_number: 1 }], [{}, {}], []],
    ]);
    const store = postgresAttemptStore(execute);
    const lookup = await store.loadContext(STUDENT, READING);
    assert.equal(lookup.status, "ok");
    assert.equal(await store.claim(STUDENT, READING, "c1", 0), "claimed");
    assert.equal(await store.commit(SAVE), 1);
    assert.deepEqual(calls.map((c) => c.length), [4, 3, 5]);
  });

  it("propagates executor errors (fail closed)", async () => {
    const store = postgresAttemptStore(async () => {
      throw new Error("db down");
    });
    await assert.rejects(store.claim(STUDENT, READING, "c1", 0), /db down/);
    await assert.rejects(store.release(STUDENT, READING, "c1"), /db down/);
  });

  it("after a commit error, sends the release batch and rethrows (fake executor)", async () => {
    const calls: Statement[][] = [];
    const responses: (Record<string, unknown>[][] | Error)[] = [
      [[{ body_text: "t", grade_level: "4" }], QUESTIONS, [{ tries: 0, passed: false }]],
      [[{}], [{ id: "c1" }], [{}]],
      new Error("connection reset"),
      [[]],
    ];
    const execute = async (statements: Statement[]) => {
      calls.push(statements);
      const next = responses.shift() ?? [];
      if (next instanceof Error) throw next;
      return next;
    };
    const store = postgresAttemptStore(execute);
    await assert.rejects(
      submitAnswersWith(STUDENT, READING, ANSWERS, { store, check: fakeChecker().check, newId: () => "c1" }),
      /connection reset/,
    );
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[3], [releaseStatement(STUDENT, READING, "c1")]);
  });

  it("releases as error, or given back when the model never replied, only an unfinished claim", () => {
    const s = releaseStatement(STUDENT, READING, "c1");
    assert.match(s.text, /set finished_at = now\(\),\n  outcome = case when \$4::boolean then 'given_back' else 'error' end/);
    assert.match(s.text, /finished_at is null/);
    assert.deepEqual(s.params, [STUDENT, READING, "c1", false]);
    assert.deepEqual(releaseStatement(STUDENT, READING, "c1", true).params, [STUDENT, READING, "c1", true]);
  });

  it("pausedUntil: the oldest given-back check in the window, plus the window", () => {
    const s = pausedUntilStatement(STUDENT, READING);
    assert.match(s.text, /^select min\(created_at\) \+ make_interval\(mins => \$3::int\) as retry_at\nfrom effort_checks/);
    assert.match(s.text, /outcome = 'given_back'\n  and created_at > now\(\) - make_interval\(mins => \$3::int\)/);
    assert.deepEqual(s.params, [STUDENT, READING, EFFORT_GIVEN_BACK_WINDOW_MINUTES]);
    assert.match(pausedUntilStatement("a1", READING, "self_effort_checks", "account_id").text, /from self_effort_checks\nwhere account_id = \$1::uuid/);
  });
});
