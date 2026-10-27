import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QUESTIONS_SYSTEM_PROMPT, QUESTIONS_TOOL_NAME, SOLO_QUESTIONS_SYSTEM_PROMPT } from "./ai/prompts";
import type { ModelRequest } from "./ai/model";
import { QuestionWriterError, type QuestionModel } from "./ai/questions";
import { toolReply } from "./ai/test-fixtures";
import type { Statement } from "./link-rate-limit";
import { QUESTION_GENERATION_LIMIT, QUESTION_GENERATION_WINDOW_MINUTES } from "./question-rate-limit";
import {
  getOrCreateSelfQuestionsWith,
  postgresSelfQuestionStore,
  selfClaimOutcome,
  selfClaimStatements,
  selfCommitStatement,
  selfQuestionsView,
  selfQuestionWriter,
  selfReleaseSlotStatement,
  selfReleaseStatement,
  type SelfQuestionStore,
} from "./self-questions-core";
import { CLAIM_STALE_SECONDS, STUDENT_GENERATION_THROTTLED_MESSAGE } from "./student-questions-core";
import { QUESTIONS_ERROR_MESSAGE } from "./student-reading-view";

const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const READING = "00000000-0000-4000-8000-0000000000b1";
const PROMPTS = ["Why did Mia go out?", "What did the fox do?", "What do you think?"];
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

// In-memory store: one reading owned by ACCOUNT, claim and commit atomic.
// slotFree says whether a released reading could take a slot back.
function fakeStore(options: { limit?: number; slotFree?: boolean } = {}) {
  const state = { questions: [] as string[], token: null as string | null, generations: 0, writes: 0, released: false };
  const limit = options.limit ?? QUESTION_GENERATION_LIMIT;
  const store: SelfQuestionStore = {
    async loadContext(accountId) {
      await tick();
      return accountId === ACCOUNT ? { bodyText: "text", gradeLevel: "5", questionCount: 3 } : null;
    },
    async readQuestions(accountId) {
      await tick();
      return accountId === ACCOUNT ? state.questions.map((prompt, i) => ({ id: `q${i + 1}`, position: i + 1, prompt })) : [];
    },
    async claim(accountId, _r, token) {
      await tick();
      if (accountId !== ACCOUNT) return "not_found";
      if (state.questions.length > 0) return "ready";
      if (state.token) return "pending";
      if (state.released && options.slotFree === false) return "limit_reached";
      if (state.generations >= limit) return "rate_limited";
      state.generations++;
      state.token = token;
      state.released = false;
      return "claimed";
    },
    async release(_a, _r, token) {
      await tick();
      if (state.token === token) {
        state.token = null;
        if (state.questions.length === 0) state.released = true;
      }
    },
    async releaseSlot() {
      await tick();
      if (!state.token && state.questions.length === 0) state.released = true;
    },
    async allowanceState() {
      return { used: 5, remaining: 0, nextFreeAt: new Date("2026-10-30T09:00:00Z") };
    },
    async commit(_a, _r, token, prompts) {
      await tick();
      if (state.token !== token) return false;
      state.token = null;
      state.questions = prompts;
      return true;
    },
  };
  return { store, state };
}

let n = 0;
const newToken = () => `t${++n}`;

describe("getOrCreateSelfQuestionsWith", () => {
  it("writes the set once, then serves it from the cache", async () => {
    const { store, state } = fakeStore();
    const write = async () => {
      state.writes++;
      return PROMPTS;
    };
    const first = await getOrCreateSelfQuestionsWith(ACCOUNT, READING, { store, write, newToken });
    assert.equal(first.status, "ready");
    const again = await getOrCreateSelfQuestionsWith(ACCOUNT, READING, { store, write, newToken });
    assert.equal(again.status === "ready" && again.questions.length, 3);
    assert.equal(state.writes, 1);
  });

  it("20 opens at once call the model once", async () => {
    const { store, state } = fakeStore();
    const write = async () => {
      state.writes++;
      await new Promise((r) => setTimeout(r, 20));
      return PROMPTS;
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => getOrCreateSelfQuestionsWith(ACCOUNT, READING, { store, write, newToken })),
    );
    assert.equal(state.writes, 1);
    assert.ok(results.every((r) => r.status === "ready" || r.status === "pending"));
  });

  it("another account's reading is not_found, and nothing is written", async () => {
    const { store, state } = fakeStore();
    const result = await getOrCreateSelfQuestionsWith(OTHER, READING, { store, write: async () => PROMPTS, newToken });
    assert.deepEqual(result, { status: "not_found" });
    assert.equal(state.generations, 0);
  });

  it("a model failure releases the claim (Try again can claim), and is an error", async () => {
    const { store, state } = fakeStore();
    const failing = async (): Promise<string[]> => {
      throw new QuestionWriterError("busy", "529");
    };
    const logs: Record<string, unknown>[] = [];
    const result = await getOrCreateSelfQuestionsWith(ACCOUNT, READING, {
      store,
      write: failing,
      newToken,
      onError: (f) => logs.push(f),
    });
    assert.deepEqual(result, { status: "error", kind: "busy" });
    assert.equal(state.token, null);
    assert.equal(logs[0].kind, "busy");
    // The failed write gave the weekly slot back...
    assert.equal(state.released, true);
    const retry = await getOrCreateSelfQuestionsWith(ACCOUNT, READING, { store, write: async () => PROMPTS, newToken });
    assert.equal(retry.status, "ready");
    assert.equal(state.generations, 2);
    // ...and the Try again that wrote the set took it back.
    assert.equal(state.released, false);
  });

  it("a Try again on a released reading with no free slot is limit_reached, with no model call", async () => {
    const { store, state } = fakeStore({ slotFree: false });
    const failing = async (): Promise<string[]> => {
      throw new QuestionWriterError("failed", "500");
    };
    await getOrCreateSelfQuestionsWith(ACCOUNT, READING, { store, write: failing, newToken });
    const write = async () => {
      state.writes++;
      return PROMPTS;
    };
    const result = await getOrCreateSelfQuestionsWith(ACCOUNT, READING, { store, write, newToken });
    assert.deepEqual(result, { status: "limit_reached", state: { used: 5, remaining: 0, nextFreeAt: new Date("2026-10-30T09:00:00Z") } });
    assert.equal(state.writes, 0);
    assert.equal(selfQuestionsView(result).kind, "limit_reached");
  });

  it("at the account's generation limit: rate_limited, no model call", async () => {
    const { store, state } = fakeStore({ limit: 0 });
    const result = await getOrCreateSelfQuestionsWith(ACCOUNT, READING, {
      store,
      write: async () => {
        state.writes++;
        return PROMPTS;
      },
      newToken,
    });
    assert.deepEqual(result, { status: "rate_limited" });
    assert.equal(state.writes, 0);
    assert.equal(state.released, true, "an open that can't write gives the slot back");
  });

  it("without a key: an error before any claim", async () => {
    const { store, state } = fakeStore();
    const result = await getOrCreateSelfQuestionsWith(ACCOUNT, READING, { store, write: async () => PROMPTS, newToken, configured: false });
    assert.deepEqual(result, { status: "error", kind: "not_configured" });
    assert.equal(state.generations, 0);
    assert.equal(state.released, true, "not set up gives the slot back");
  });
});

describe("selfQuestionsView", () => {
  it("maps results to the student read view kinds, with no teacher to ask", () => {
    assert.deepEqual(selfQuestionsView({ status: "rate_limited" }), { kind: "throttled", message: STUDENT_GENERATION_THROTTLED_MESSAGE });
    assert.deepEqual(selfQuestionsView({ status: "error", kind: "failed" }), { kind: "error", message: QUESTIONS_ERROR_MESSAGE });
    assert.deepEqual(selfQuestionsView({ status: "pending", retryAfterMs: 2000 }), { kind: "pending", retryAfterMs: 2000 });
    assert.deepEqual(selfQuestionsView({ status: "not_found" }), { kind: "not_found" });
  });
});

describe("self question statements", () => {
  const [lock, claim, prune, why] = selfClaimStatements(ACCOUNT, READING, "t1");

  it("lock the account row, then count the generation and take the claim in one statement", () => {
    assert.equal(lock.text, "select id from teachers where id = $1::uuid for update");
    assert.match(claim.text, /^with counted as \(\n  insert into question_generation_attempts \(teacher_id\)/);
    assert.match(claim.text, /r\.id = \$2::uuid and r\.account_id = \$1::uuid/);
    assert.match(claim.text, /not exists \(select 1 from self_questions q where q\.reading_id = r\.id\)/);
    assert.match(claim.text, /update self_readings set questions_claim_token = \$3::uuid/);
    assert.deepEqual(claim.params, [ACCOUNT, READING, "t1", CLAIM_STALE_SECONDS, QUESTION_GENERATION_WINDOW_MINUTES, QUESTION_GENERATION_LIMIT, 5, 7]);
    assert.match(prune.text, /^delete from question_generation_attempts/);
    assert.match(why.text, /as owned/);
  });

  it("the claim, its report, and the commit re-check the self-learner role in the statement", () => {
    const role = /join teachers t on t\.id = r\.account_id\n  where r\.id = \$2::uuid and r\.account_id = \$1::uuid and t\.role = 'self_learner'/;
    assert.match(claim.text, role);
    assert.match(why.text, /t\.role = 'self_learner'\n  \) as owned/);
    const commit = selfCommitStatement(ACCOUNT, READING, "t1", PROMPTS);
    assert.match(commit.text, /and exists \(select 1 from teachers t where t\.id = \$1::uuid and t\.role = 'self_learner'\)\n  returning id/);
  });

  it("the claim takes a released slot back only while one is free, in the same statement", () => {
    assert.match(claim.text, /set questions_claim_token = \$3::uuid, questions_claimed_at = now\(\), slot_released_at = null/);
    assert.match(claim.text, /r\.slot_released_at is null or r\.created_at <= now\(\) - make_interval\(days => \$8::int\)/);
    assert.match(claim.text, /where account_id = \$1::uuid and slot_released_at is null\n    and created_at > now\(\) - make_interval\(days => \$8::int\)\) < \$7::int/);
    assert.match(why.text, /as slot_free$/);
  });

  it("the release gives the slot back only while there are no questions", () => {
    const release = selfReleaseStatement(ACCOUNT, READING, "t1");
    assert.match(release.text, /when exists \(select 1 from self_questions q where q\.reading_id = self_readings\.id\) then slot_released_at/);
    assert.match(release.text, /else coalesce\(slot_released_at, now\(\)\)/);
    const slot = selfReleaseSlotStatement(ACCOUNT, READING);
    assert.match(slot.text, /^update self_readings set slot_released_at = now\(\)/);
    assert.match(slot.text, /not exists \(select 1 from self_questions q/);
    assert.match(slot.text, /questions_claim_token is null or questions_claimed_at < now\(\) - make_interval\(secs => \$3::int\)/);
    assert.deepEqual(slot.params, [ACCOUNT, READING, CLAIM_STALE_SECONDS]);
  });

  it("selfClaimOutcome says why", () => {
    assert.equal(
      selfClaimOutcome([[], [], [], [{ owned: true, has_questions: false, claimable: true, recent: 0, slot_free: false }]]),
      "limit_reached",
    );
    assert.equal(selfClaimOutcome([[], [{ id: READING }], [], []]), "claimed");
    assert.equal(selfClaimOutcome([[], [], [], [{ owned: false }]]), "not_found");
    assert.equal(selfClaimOutcome([[], [], [], [{ owned: true, has_questions: true }]]), "ready");
    assert.equal(selfClaimOutcome([[], [], [], [{ owned: true, has_questions: false, claimable: false, recent: 0 }]]), "pending");
    assert.equal(
      selfClaimOutcome([[], [], [], [{ owned: true, has_questions: false, claimable: true, recent: QUESTION_GENERATION_LIMIT }]]),
      "rate_limited",
    );
  });

  it("commit and release only act for this token, scoped to the account", () => {
    const commit = selfCommitStatement(ACCOUNT, READING, "t1", PROMPTS);
    assert.match(commit.text, /questions_claim_token = \$3::uuid/);
    assert.match(commit.text, /insert into self_questions \(reading_id, position, prompt\)/);
    assert.deepEqual(commit.params, [ACCOUNT, READING, "t1", [1, 2, 3], PROMPTS]);
    const release = selfReleaseStatement(ACCOUNT, READING, "t1");
    assert.match(release.text, /where id = \$2::uuid and account_id = \$1::uuid and questions_claim_token = \$3::uuid/);
  });

  it("the Postgres store commits only a full set", async () => {
    const batches: Statement[][] = [];
    const store = postgresSelfQuestionStore(async (statements) => {
      batches.push(statements);
      return statements.map(() => [{ id: "x" }]);
    });
    assert.equal(await store.commit(ACCOUNT, READING, "t1", PROMPTS), false);
    assert.equal(batches.length, 1);
  });
});

describe("selfQuestionWriter", () => {
  it("writes with the solo prompts, at the reading's level and count", async () => {
    const calls: ModelRequest[] = [];
    let gets = 0;
    const model: QuestionModel = {
      model: "anthropic/claude-sonnet-5.5",
      create: async (params) => {
        calls.push(params);
        return toolReply(QUESTIONS_TOOL_NAME, { questions: ["Why?", "What next?"] });
      },
    };
    const write = selfQuestionWriter(() => {
      gets++;
      return model;
    });
    assert.equal(gets, 0);
    const prompts = await write({ bodyText: "A fox ran into the snow.", gradeLevel: "9", questionCount: 2 });
    assert.deepEqual(prompts, ["Why?", "What next?"]);
    assert.equal(gets, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].system, SOLO_QUESTIONS_SYSTEM_PROMPT);
    assert.notEqual(calls[0].system, QUESTIONS_SYSTEM_PROMPT);
    const user = String(calls[0].messages[0].content);
    assert.match(user, /Grade level: grade 9\./);
    assert.match(user, /Write exactly 2 questions/);
    assert.match(user, /A fox ran into the snow\./);
    assert.match(user, /Write for a high school reading level\./);
    assert.match(user, /the reader's own opinion/);
    assert.doesNotMatch(user, /teacher|student|class/i);
  });
});
