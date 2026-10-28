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
  SELF_QUESTIONS_LIMITED_MESSAGE,
  selfReleaseStatement,
  type SelfQuestionStore,
} from "./self-questions-core";
import { CLAIM_STALE_SECONDS } from "./student-questions-core";
import { QUESTIONS_ERROR_MESSAGE } from "./student-reading-view";

const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const READING = "00000000-0000-4000-8000-0000000000b1";
const PROMPTS = ["Why did Mia go out?", "What did the fox do?", "What do you think?"];
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

// In-memory store: one reading owned by ACCOUNT, claim and commit atomic.
// slotFree says whether a released reading could take a slot back.
// releases counts release calls (the only way a slot is given back).
function fakeStore(options: { limit?: number; slotFree?: boolean } = {}) {
  const state = {
    questions: [] as string[],
    token: null as string | null,
    generations: 0,
    writes: 0,
    released: false,
    releases: 0,
    limit: options.limit ?? QUESTION_GENERATION_LIMIT,
  };
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
      if (state.generations >= state.limit) return "rate_limited";
      state.generations++;
      state.token = token;
      state.released = false;
      return "claimed";
    },
    async release(_a, _r, token) {
      await tick();
      state.releases++;
      if (state.token === token) {
        state.token = null;
        if (state.questions.length === 0) state.released = true;
      }
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

  it("at the account's generation limit: rate_limited, no model call, and the reading keeps its slot", async () => {
    const { store, state } = fakeStore({ limit: 0 });
    const write = async () => {
      state.writes++;
      return PROMPTS;
    };
    for (let i = 0; i < 3; i++) {
      const result = await getOrCreateSelfQuestionsWith(ACCOUNT, READING, { store, write, newToken });
      assert.deepEqual(result, { status: "rate_limited", retryAt: null });
    }
    assert.equal(state.writes, 0);
    assert.equal(state.releases, 0);
    assert.equal(state.released, false, "a refused open keeps the slot, so create, open, repeat can't cycle slots");
    // After the wait, Try again writes the set with the slot it kept.
    state.limit = QUESTION_GENERATION_LIMIT;
    const later = await getOrCreateSelfQuestionsWith(ACCOUNT, READING, { store, write, newToken });
    assert.equal(later.status, "ready");
    assert.equal(state.writes, 1);
    assert.equal(state.released, false);
  });

  it("without a key: not_configured before any claim, and the reading keeps its slot", async () => {
    const { store, state } = fakeStore();
    const result = await getOrCreateSelfQuestionsWith(ACCOUNT, READING, { store, write: async () => PROMPTS, newToken, configured: false });
    assert.deepEqual(result, { status: "error", kind: "not_configured" });
    assert.equal(state.generations, 0);
    assert.equal(state.releases, 0);
    assert.equal(state.released, false, "no model call was made, so nothing is given back");
    // Once set up, the next open writes the set with the slot it kept.
    const later = await getOrCreateSelfQuestionsWith(ACCOUNT, READING, { store, write: async () => PROMPTS, newToken });
    assert.equal(later.status, "ready");
    assert.equal(state.released, false);
  });

  it("another tab's live claim is pending and keeps the slot", async () => {
    const { store, state } = fakeStore();
    state.token = "other-tab";
    const result = await getOrCreateSelfQuestionsWith(ACCOUNT, READING, { store, write: async () => PROMPTS, newToken });
    assert.equal(result.status, "pending");
    assert.equal(state.releases, 0);
    assert.equal(state.released, false);
  });

  it("not_found keeps every slot and calls nothing", async () => {
    const { store, state } = fakeStore();
    await getOrCreateSelfQuestionsWith(OTHER, READING, { store, write: async () => PROMPTS, newToken, configured: false });
    await getOrCreateSelfQuestionsWith(OTHER, READING, { store, write: async () => PROMPTS, newToken });
    assert.equal(state.releases, 0);
    assert.equal(state.released, false);
  });

  it("an attempted write that fails releases the slot, whatever the kind (a 402 or a provider outage too)", async () => {
    for (const [kind, reason] of [
      ["not_configured", "402"],
      ["busy", "529"],
      ["timeout", "deadline"],
      ["failed", "500"],
    ] as const) {
      const { store, state } = fakeStore();
      const result = await getOrCreateSelfQuestionsWith(ACCOUNT, READING, {
        store,
        write: async () => {
          throw new QuestionWriterError(kind, reason);
        },
        newToken,
      });
      assert.deepEqual(result, { status: "error", kind });
      assert.equal(state.generations, 1, `${kind}: the attempt counted toward the question limit`);
      assert.equal(state.releases, 1);
      assert.equal(state.released, true, `${kind}: the slot is given back`);
    }
  });
});

describe("selfQuestionsView", () => {
  it("maps results to the student read view kinds, with no teacher to ask", () => {
    assert.deepEqual(selfQuestionsView({ status: "rate_limited", retryAt: null }), {
      kind: "throttled",
      message: `${SELF_QUESTIONS_LIMITED_MESSAGE} Try again in a few minutes.`,
    });
    const clock = { now: new Date("2026-10-27T14:30:00Z"), timeZone: "America/New_York", utcLabel: false };
    assert.deepEqual(selfQuestionsView({ status: "rate_limited", retryAt: new Date("2026-10-27T14:40:00Z") }, clock), {
      kind: "throttled",
      message: "You’ve asked for a lot of questions in the last 10 minutes, so let’s take a short break. You can try again at 10:40 AM.",
    });
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
    assert.match(release.text, /questions_claim_token = \$3::uuid$/, "only the token whose write failed");
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
