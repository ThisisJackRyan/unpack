import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EffortCheckInput, EffortVerdict } from "./ai/effort-check";
import { EFFORT_SYSTEM_PROMPT, EFFORT_TOOL_NAME, SOLO_EFFORT_SYSTEM_PROMPT } from "./ai/effort-prompts";
import type { ModelRequest } from "./ai/model";
import type { QuestionModel } from "./ai/questions";
import { toolReply } from "./ai/test-fixtures";
import type { AttemptView, ReadingProgress } from "./reading-progress";
import {
  postgresSelfAttemptStore,
  SELF_EFFORT_LOCK_SPACE,
  selfClaimCheckStatements,
  selfCommitStatements,
  selfEffortChecker,
  selfProgress,
  selfProgressStatements,
  selfReleaseCheckStatements,
  selfSubmitContextStatements,
  settleStatusStatement,
  SOLO_CHECKS_USED_MESSAGE,
  soloAnnouncement,
  soloStage,
  soloSubmitMessage,
} from "./self-answers-core";
import type { Statement } from "./link-rate-limit";
import {
  claimOutcome,
  committedTry,
  EFFORT_CLAIM_STALE_SECONDS,
  submitAnswersWith,
  submitLookup,
  type AttemptStore,
  type SaveInput,
} from "./submit-answers-core";
import { EFFORT_CHECK_LIMIT, MAX_TRIES } from "./validate-answers";

const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const READING = "00000000-0000-4000-8000-0000000000b1";
const QUESTIONS = [
  { id: "q1", position: 1, prompt: "Why did Mia go out?" },
  { id: "q2", position: 2, prompt: "What do you think?" },
];
const ANSWERS = [
  { questionId: "q1", value: "to see the snow" },
  { questionId: "q2", value: "I think she was brave" },
];

type Status = "in_progress" | "passed" | "moved_on";

// In-memory self-learner store with the same rules as the Postgres one,
// including the status settle that runs with every commit and release.
function soloStore() {
  const state = {
    attempts: [] as AttemptView[],
    checks: [] as { id: string; finished: boolean }[],
    status: "in_progress" as Status,
    challengeRows: 0,
  };
  const passed = () => state.attempts.some((a) => a.result === "pass");
  // Locked: passed on the latest try.
  const locked = () => Object.entries(state.attempts.at(-1)?.answers ?? {}).filter(([, a]) => a.pass);
  const settle = () => {
    if (state.status !== "in_progress") return;
    if (passed()) state.status = "passed";
    else if (state.attempts.length >= MAX_TRIES || state.checks.length >= EFFORT_CHECK_LIMIT) state.status = "moved_on";
  };
  const store: AttemptStore = {
    async loadContext() {
      return {
        status: "ok",
        context: {
          bodyText: "text",
          gradeLevel: "6",
          questions: QUESTIONS,
          lockedQuestionIds: locked().map(([id]) => id),
          tries: state.attempts.length,
          triesAllowed: MAX_TRIES,
          passed: passed(),
        },
      };
    },
    async claim(_a, _r, claimId, expectedTries) {
      if (passed()) return "already_passed";
      if (state.attempts.length >= MAX_TRIES) return "out_of_tries";
      if (state.checks.some((c) => !c.finished)) return "busy";
      if (state.attempts.length !== expectedTries) return "stale";
      if (state.checks.length >= EFFORT_CHECK_LIMIT) return "too_many_checks";
      state.checks.push({ id: claimId, finished: false });
      return "claimed";
    },
    async release(_a, _r, claimId) {
      const c = state.checks.find((x) => x.id === claimId);
      if (c) c.finished = true;
      settle();
    },
    async commit(input: SaveInput) {
      const c = state.checks.find((x) => x.id === input.claimId && !x.finished);
      if (!c || passed() || state.attempts.length >= MAX_TRIES) return null;
      c.finished = true;
      const tryNumber = state.attempts.length + 1;
      state.attempts.push({
        tryNumber,
        result: input.passed ? "pass" : "fail",
        // The locked answers carried over, never replaced.
        answers: {
          ...Object.fromEntries(input.verdicts.map((v) => [v.questionId, { text: v.text, pass: v.pass, nudge: v.nudge }])),
          ...Object.fromEntries(locked().map(([id, a]) => [id, { ...a, nudge: "" }])),
        },
      });
      settle();
      return tryNumber;
    },
  };
  const progress = (): ReadingProgress => ({
    attempts: state.attempts,
    challenge: null,
    checks: state.checks.length,
    limits: { tries: MAX_TRIES, checks: EFFORT_CHECK_LIMIT },
  });
  return { store, state, progress };
}

function checker(pass: boolean) {
  return async (input: EffortCheckInput): Promise<EffortVerdict[]> =>
    input.items.map((i) => ({ questionId: i.questionId, pass, nudge: pass ? "" : "Name one detail from the text." }));
}

let n = 0;
const newId = () => `id-${++n}`;

describe("solo flow (submitAnswersWith over the self store)", () => {
  it("3 failed tries: moved on, with the last try's nudges, and no challenge", async () => {
    const { store, state, progress } = soloStore();
    for (let i = 1; i <= MAX_TRIES; i++) {
      assert.equal(soloStage(progress()).kind, "answer");
      const result = await submitAnswersWith(ACCOUNT, READING, ANSWERS, { store, check: checker(false), newId });
      assert.equal(result.status, "checked");
      assert.equal(result.status === "checked" && result.tryNumber, i);
    }
    assert.equal(state.status, "moved_on");
    const stage = soloStage(progress());
    assert.equal(stage.kind, "moved_on");
    if (stage.kind === "moved_on") {
      assert.equal(stage.reason, "tries");
      assert.equal(stage.attempt?.tryNumber, 3);
      assert.equal(stage.attempt?.answers.q1.nudge, "Name one detail from the text.");
    }
    // A 4th submit is refused before any check.
    const fourth = await submitAnswersWith(ACCOUNT, READING, ANSWERS, { store, check: checker(true), newId });
    assert.deepEqual(fourth, { status: "out_of_tries" });
    assert.equal(state.checks.length, 3);
    assert.equal(state.challengeRows, 0);
  });

  it("a passing try marks it passed", async () => {
    const { store, state, progress } = soloStore();
    await submitAnswersWith(ACCOUNT, READING, ANSWERS, { store, check: checker(false), newId });
    const result = await submitAnswersWith(ACCOUNT, READING, ANSWERS, { store, check: checker(true), newId });
    assert.equal(result.status === "checked" && result.passed, true);
    assert.equal(state.status, "passed");
    assert.equal(soloStage(progress()).kind, "passed");
    assert.deepEqual(await submitAnswersWith(ACCOUNT, READING, ANSWERS, { store, check: checker(true), newId }), {
      status: "already_passed",
    });
  });

  it("every check failing on our side: moved on once the check limit is used, try unused", async () => {
    const { store, state, progress } = soloStore();
    const broken = async (): Promise<EffortVerdict[]> => {
      throw new Error("model down");
    };
    for (let i = 0; i < EFFORT_CHECK_LIMIT; i++) {
      assert.deepEqual(await submitAnswersWith(ACCOUNT, READING, ANSWERS, { store, check: broken, newId }), {
        status: "check_failed",
      });
    }
    assert.equal(state.status, "moved_on");
    const stage = soloStage(progress());
    assert.equal(stage.kind === "moved_on" && stage.reason, "checks");
    assert.deepEqual(await submitAnswersWith(ACCOUNT, READING, ANSWERS, { store, check: checker(true), newId }), {
      status: "too_many_checks",
    });
    assert.equal(soloSubmitMessage("too_many_checks"), SOLO_CHECKS_USED_MESSAGE);
    assert.equal(/teacher/i.test(SOLO_CHECKS_USED_MESSAGE), false);
  });
});

describe("solo flow: passed answers are locked", () => {
  it("pass q1 on try 1: try 2 sends only q2, a crafted q1 is refused, and q1 stays as it was", async () => {
    const { store, state, progress } = soloStore();
    const seen: string[][] = [];
    const check = async (input: EffortCheckInput): Promise<EffortVerdict[]> => {
      seen.push(input.items.map((i) => i.questionId));
      return input.items.map((i) => ({
        questionId: i.questionId,
        pass: seen.length > 1 || i.questionId === "q1",
        nudge: seen.length > 1 || i.questionId === "q1" ? "" : "Say why.",
      }));
    };
    const one = await submitAnswersWith(ACCOUNT, READING, ANSWERS, { store, check, newId });
    assert.equal(one.status === "checked" && one.passed, false);
    // Try 2 from a crafted form that also changes q1: nothing is checked.
    const crafted = [{ questionId: "q1", value: "changed" }, ANSWERS[1]];
    assert.deepEqual(await submitAnswersWith(ACCOUNT, READING, crafted, { store, check, newId }), { status: "stale" });
    assert.equal(state.checks.length, 1);
    const two = await submitAnswersWith(ACCOUNT, READING, [ANSWERS[1]], { store, check, newId });
    assert.equal(two.status === "checked" && two.passed, true);
    assert.deepEqual(seen, [["q1", "q2"], ["q2"]]);
    assert.equal(state.status, "passed");
    assert.equal(state.attempts[1].answers.q1.text, "to see the snow");
    assert.equal(state.attempts[1].answers.q1.pass, true);
    assert.equal(state.checks.length, 2);
    assert.equal(soloStage(progress()).kind, "passed");
  });
});

describe("soloStage and messages", () => {
  const fail: AttemptView = { tryNumber: 1, result: "fail", answers: { q1: { text: "a", pass: false, nudge: "Say more." } } };

  it("answer, with the previous try for the nudges and never an extra try", () => {
    const stage = soloStage({ attempts: [fail], challenge: null, checks: 1, limits: { tries: 3, checks: 6 } });
    assert.deepEqual(stage, { kind: "answer", tryNumber: 2, maxTries: 3, previous: fail, extraTry: false });
    assert.equal(soloAnnouncement(stage), "Not yet. Read the tips and try again. This is try 2 of 3.");
  });

  it("ignores any challenge (there is no challenge step)", () => {
    const stage = soloStage({
      attempts: [fail, { ...fail, tryNumber: 2 }, { ...fail, tryNumber: 3 }],
      challenge: { status: "open", extraTry: false },
      checks: 3,
      limits: { tries: 3, checks: 6 },
    });
    assert.equal(stage.kind, "moved_on");
  });

  it("no message mentions a teacher or a note", () => {
    for (const s of ["already_passed", "out_of_tries", "busy", "too_many_checks", "check_failed", "timed_out", "stale", "not_found"] as const) {
      assert.equal(/teacher|note/i.test(soloSubmitMessage(s)), false, s);
    }
  });
});

describe("self store statements", () => {
  const all = (statements: Statement[]) => statements.map((s) => s.text).join("\n");
  const input: SaveInput = {
    studentId: ACCOUNT,
    readingId: READING,
    claimId: "c1",
    attemptId: "a1",
    passed: false,
    verdicts: [{ questionId: "q1", text: "x", pass: false, nudge: "n" }],
  };

  it("touch only self_* tables, never challenges, classes, or students", () => {
    const text = all([
      ...selfSubmitContextStatements(ACCOUNT, READING),
      ...selfClaimCheckStatements(ACCOUNT, READING, "c1", 0),
      ...selfReleaseCheckStatements(ACCOUNT, READING, "c1"),
      ...selfCommitStatements(input),
      ...selfProgressStatements(ACCOUNT, READING),
    ]);
    // With every self_* name taken out, no table name is left.
    const others = text.replace(/self_\w+/g, "");
    assert.equal(/\b(from|join|into|update)\s+(challenges|classes|students|readings|questions|attempts|answers|effort_checks)\b/.test(others), false);
    assert.equal(/challenges/.test(text), false);
  });

  it("scope every read and write to the account", () => {
    for (const s of [...selfSubmitContextStatements(ACCOUNT, READING), ...selfClaimCheckStatements(ACCOUNT, READING, "c1", 0).slice(1)]) {
      assert.match(s.text, /account_id = \$1::uuid/);
      assert.equal(s.params[0], ACCOUNT);
    }
  });

  it("the claim, its report, and the commit check ownership and the self-learner role in the statement", () => {
    const owned = "select 1 from self_readings r join teachers t on t.id = r.account_id\n  where r.id = $2::uuid and r.account_id = $1::uuid and t.role = 'self_learner'";
    const [, insert, why] = selfClaimCheckStatements(ACCOUNT, READING, "c1", 0);
    assert.ok(insert.text.includes(`where exists (\n  ${owned}\n)`), insert.text);
    assert.ok(why.text.includes(owned));
    const [, commit] = selfCommitStatements(input);
    // In the claim's update, so the attempt and its answers are only
    // inserted for an owned reading of a self-learner.
    const update = commit.text.slice(0, commit.text.indexOf("returning id"));
    assert.ok(update.includes(owned), commit.text);
    assert.match(update, /account_id = \$1::uuid and reading_id = \$2::uuid/);
  });

  it("claim and commit take the reading's advisory lock first", () => {
    for (const batch of [selfClaimCheckStatements(ACCOUNT, READING, "c1", 0), selfCommitStatements(input), selfReleaseCheckStatements(ACCOUNT, READING, "c1")]) {
      assert.equal(batch[0].text, "select pg_advisory_xact_lock($1::int, hashtext($2::text))");
      assert.deepEqual(batch[0].params, [SELF_EFFORT_LOCK_SPACE, READING]);
    }
  });

  it("the claim enforces 3 tries, one live check, and the check limit", () => {
    const [, insert] = selfClaimCheckStatements(ACCOUNT, READING, "c1", 0);
    assert.match(insert.text, /^insert into self_effort_checks \(id, account_id, reading_id\)/);
    assert.deepEqual(insert.params, [ACCOUNT, READING, "c1", EFFORT_CLAIM_STALE_SECONDS, MAX_TRIES, EFFORT_CHECK_LIMIT, 10, 3, 0]);
    // Still exactly the tries the answers were validated against.
    assert.match(insert.text, /and \(select count\(\*\) from self_attempts where reading_id = \$2::uuid and account_id = \$1::uuid\) = \$9::int/);
    assert.match(insert.text, /and outcome is distinct from 'given_back'\) < \$6::int/);
    assert.match(insert.text, /outcome = 'given_back'\n    and created_at > now\(\) - make_interval\(mins => \$7::int\)\) < \$8::int/);
    const [, release] = selfReleaseCheckStatements(ACCOUNT, READING, "c1", true);
    assert.match(release.text, /outcome = case when \$4::boolean then 'given_back' else 'error' end/);
    assert.deepEqual(release.params, [ACCOUNT, READING, "c1", true]);
  });

  it("lock passed answers over the self tables: read from the latest try, carried into the new one, never replaced", () => {
    const locked = selfSubmitContextStatements(ACCOUNT, READING)[3];
    assert.match(locked.text, /^select an\.question_id from self_answers an\nwhere an\.ai_pass and an\.attempt_id = \(\s*select a\.id from self_attempts a\s*where a\.account_id = \$1::uuid/);
    const [, , carry, answers] = selfCommitStatements(input);
    assert.match(carry.text, /^insert into self_answers \(attempt_id, question_id, text, ai_pass, ai_feedback\)\nselect \$3::uuid, p\.question_id, p\.text, true, null\nfrom self_answers p/);
    assert.match(carry.text, /a\.account_id = \$1::uuid and a\.reading_id = \$2::uuid and a\.id <> \$3::uuid/);
    assert.deepEqual(carry.params, [ACCOUNT, READING, "a1"]);
    assert.match(answers.text, /^insert into self_answers[\s\S]*on conflict \(attempt_id, question_id\) do nothing/);
  });

  it("the commit and the release end by settling the status", () => {
    assert.deepEqual(selfCommitStatements(input).at(-1), settleStatusStatement(ACCOUNT, READING));
    assert.deepEqual(selfReleaseCheckStatements(ACCOUNT, READING, "c1").at(-1), settleStatusStatement(ACCOUNT, READING));
    const settle = settleStatusStatement(ACCOUNT, READING);
    assert.match(settle.text, /status = 'in_progress'/);
    assert.match(settle.text, /'moved_on'::self_reading_status/);
  });

  it("result shapes match the shared readers", () => {
    assert.equal(claimOutcome([[], [{ id: "c1" }], []]), "claimed");
    assert.equal(
      claimOutcome([[], [], [{ eligible: true, passed: false, tries: 3, live: false, checks: 3, tries_allowed: 3, checks_allowed: 6 }]]),
      "out_of_tries",
    );
    assert.equal(claimOutcome([[], [], [{ eligible: false }]]), "not_found");
    assert.equal(committedTry([[], [{ try_number: 2 }], [], [], []]), 2);
    const lookup = submitLookup([[{ body_text: "b", grade_level: "6" }], [{ id: "q1", position: 1, prompt: "p" }], [{ tries: 1, passed: false, tries_allowed: 3 }]]);
    assert.equal(lookup.status === "ok" && lookup.context.triesAllowed, 3);
    assert.deepEqual(submitLookup([[], [], []]), { status: "not_found" });
    const progress = selfProgress([[], [{ try_number: 1, result: "fail", answers: [] }], [{ status: null, extra_try: null, tries_allowed: 3, checks_allowed: 6 }], [{ checks: 1 }]]);
    assert.equal(progress.attempts.length, 1);
    assert.equal(progress.challenge, null);
    assert.equal(progress.checks, 1);
  });

  it("postgresSelfAttemptStore runs each step as one batch", async () => {
    const batches: Statement[][] = [];
    const store = postgresSelfAttemptStore(async (statements) => {
      batches.push(statements);
      return statements.map(() => []);
    });
    await store.claim(ACCOUNT, READING, "c1", 0);
    await store.release(ACCOUNT, READING, "c1");
    assert.equal(await store.commit(input), null);
    assert.deepEqual(batches.map((b) => b.length), [3, 3, 5]);
  });
});

describe("selfEffortChecker", () => {
  it("checks with the solo prompts", async () => {
    const calls: ModelRequest[] = [];
    const model: QuestionModel = {
      model: "anthropic/claude-sonnet-5.5",
      create: async (params) => {
        calls.push(params);
        return toolReply(EFFORT_TOOL_NAME, {
          results: [{ answer: 1, pass: false, nudge: "Look at what the fox did first." }],
        });
      },
    };
    const check = selfEffortChecker(() => model);
    const verdicts = await check({
      bodyText: "A fox ran into the snow.",
      gradeLevel: "9",
      items: [{ questionId: "q1", question: "Why did the fox run?", answer: "idk" }],
    });
    assert.deepEqual(verdicts, [{ questionId: "q1", pass: false, nudge: "Look at what the fox did first." }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].system, SOLO_EFFORT_SYSTEM_PROMPT);
    assert.notEqual(calls[0].system, EFFORT_SYSTEM_PROMPT);
    const user = String(calls[0].messages[0].content);
    assert.match(user, /<reader_answer>idk<\/reader_answer>/);
    assert.match(user, /Write nudges for a high school reading level: brief and direct\./);
    assert.doesNotMatch(user, /teacher|student|class/i);
  });
});
