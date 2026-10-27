import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QuestionWriterError } from "./ai/questions";
import type { Statement } from "./link-rate-limit";
import { QUESTION_GENERATION_LIMIT, QUESTION_GENERATION_WINDOW_MINUTES } from "./question-rate-limit";
import {
  getOrCreateSelfQuestionsWith,
  postgresSelfQuestionStore,
  selfClaimOutcome,
  selfClaimStatements,
  selfCommitStatement,
  selfQuestionsView,
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
function fakeStore(options: { limit?: number } = {}) {
  const state = { questions: [] as string[], token: null as string | null, generations: 0, writes: 0 };
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
      if (state.generations >= limit) return "rate_limited";
      state.generations++;
      state.token = token;
      return "claimed";
    },
    async release(_a, _r, token) {
      await tick();
      if (state.token === token) state.token = null;
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
    const retry = await getOrCreateSelfQuestionsWith(ACCOUNT, READING, { store, write: async () => PROMPTS, newToken });
    assert.equal(retry.status, "ready");
    assert.equal(state.generations, 2);
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
  });

  it("without a key: an error before any claim", async () => {
    const { store, state } = fakeStore();
    const result = await getOrCreateSelfQuestionsWith(ACCOUNT, READING, { store, write: async () => PROMPTS, newToken, configured: false });
    assert.deepEqual(result, { status: "error", kind: "not_configured" });
    assert.equal(state.generations, 0);
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
    assert.deepEqual(claim.params, [ACCOUNT, READING, "t1", CLAIM_STALE_SECONDS, QUESTION_GENERATION_WINDOW_MINUTES, QUESTION_GENERATION_LIMIT]);
    assert.match(prune.text, /^delete from question_generation_attempts/);
    assert.match(why.text, /as owned/);
  });

  it("selfClaimOutcome says why", () => {
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
