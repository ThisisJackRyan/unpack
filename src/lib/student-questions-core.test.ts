import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import {
  CLAIM_STALE_SECONDS,
  claimOutcome,
  claimStatements,
  commitStatements,
  getOrCreateStudentQuestionsWith,
  releaseStatement,
  STUDENT_GENERATION_CALL_LIMIT,
  STUDENT_GENERATION_THROTTLED_MESSAGE,
  STUDENT_GENERATION_WINDOW_LIMIT,
  STUDENT_GENERATION_WINDOW_MINUTES,
  STUDENT_SETS_LIMITED_MESSAGE,
  STUDENT_SETS_PER_READING_LIMIT,
  studentContextStatement,
  studentFacingResult,
  takeOverOutcome,
  takeOverStatements,
  type StudentQuestion,
  type StudentQuestionsResult,
  type StudentQuestionStore,
} from "./student-questions-core";
import { QUESTION_WRITE_DEADLINE_MS } from "./ai/settings";

const READING = "r1";
const STUDENT = "s1";
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

// In-memory store with the same rules as the Postgres one: claim is an
// atomic insert-if-absent under the per-reading cap and the "Try again"
// throttle (the reading lock makes the counts and insert one step), and
// a claim or takeover records its model call; commit is all-or-nothing on
// the token. Every call yields first, so concurrent callers interleave.
// Time is in seconds.
function fakeStore(options: { published?: boolean; inClass?: boolean; count?: number } = {}) {
  const claims = new Map<string, { token: string; status: "pending" | "done"; claimedAt: number }>();
  const questions = new Map<string, StudentQuestion[]>();
  const calls = new Map<string, number[]>();
  let now = 0;
  const throttle = (k: string) => {
    const times = calls.get(k) ?? [];
    if (times.length >= STUDENT_GENERATION_CALL_LIMIT) return "calls_used_up" as const;
    const recent = times.filter((t) => t > now - STUDENT_GENERATION_WINDOW_MINUTES * 60).length;
    if (recent >= STUDENT_GENERATION_WINDOW_LIMIT) return "throttled" as const;
    return null;
  };
  const record = (k: string) => calls.set(k, [...(calls.get(k) ?? []), now]);
  let ids = 0;
  const key = (r: string, s: string) => `${r}:${s}`;
  const store: StudentQuestionStore = {
    async loadContext() {
      await tick();
      if (options.published === false) return { status: "not_found" };
      if (options.inClass === false) return { status: "not_allowed" };
      return {
        status: "ok",
        context: { bodyText: "text", gradeLevel: "4", questionCount: options.count ?? 3 },
      };
    },
    async readQuestions(r, s) {
      await tick();
      return questions.get(key(r, s)) ?? [];
    },
    async claim(r, s, token, limit) {
      await tick();
      if (claims.has(key(r, s))) return "exists";
      const held = [...claims.keys()].filter((k) => k.startsWith(`${r}:`)).length;
      if (held >= limit) return "limit_reached";
      const refused = throttle(key(r, s));
      if (refused) return refused;
      claims.set(key(r, s), { token, status: "pending", claimedAt: now });
      record(key(r, s));
      return "claimed";
    },
    async takeOverStale(r, s, token, staleSeconds) {
      await tick();
      const c = claims.get(key(r, s));
      if (!c || c.status !== "pending" || now - c.claimedAt <= staleSeconds) return "not_stale";
      const refused = throttle(key(r, s));
      if (refused) return refused;
      claims.set(key(r, s), { token, status: "pending", claimedAt: now });
      record(key(r, s));
      return "taken";
    },
    async release(r, s, token) {
      await tick();
      const c = claims.get(key(r, s));
      if (c?.token === token && c.status === "pending") claims.delete(key(r, s));
    },
    async commit(r, s, token, prompts) {
      await tick();
      const c = claims.get(key(r, s));
      if (c?.token !== token || c.status !== "pending") return false;
      if (questions.has(key(r, s))) throw Object.assign(new Error("dup"), { code: "23505" });
      c.status = "done";
      questions.set(
        key(r, s),
        prompts.map((prompt, i) => ({ id: `q${++ids}`, position: i + 1, prompt })),
      );
      return true;
    },
  };
  return {
    store,
    claims,
    questions,
    calls,
    advance: (seconds: number) => {
      now += seconds;
    },
  };
}

function fakeWriter(result: string[] | Error = ["A?", "B?", "C?"], delayMs = 5) {
  let calls = 0;
  const write = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (result instanceof Error) throw result;
    return result;
  };
  return { write, calls: () => calls };
}

let tokens = 0;
const newToken = () => `t${++tokens}`;

describe("getOrCreateStudentQuestionsWith", () => {
  it("writes once, then returns the cached set without calling the model", async () => {
    const { store } = fakeStore();
    const writer = fakeWriter();
    const first = await getOrCreateStudentQuestionsWith(READING, STUDENT, { store, write: writer.write, newToken });
    assert.equal(first.status, "ready");
    assert.deepEqual(
      first.status === "ready" && first.questions.map((q) => [q.position, q.prompt]),
      [[1, "A?"], [2, "B?"], [3, "C?"]],
    );
    const second = await getOrCreateStudentQuestionsWith(READING, STUDENT, { store, write: writer.write, newToken });
    assert.deepEqual(second, first);
    assert.equal(writer.calls(), 1);
  });

  it("calls the model once for 20 concurrent first opens", async () => {
    const { store, questions } = fakeStore();
    const writer = fakeWriter(["A?", "B?", "C?"], 20);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        getOrCreateStudentQuestionsWith(READING, STUDENT, { store, write: writer.write, newToken }),
      ),
    );
    assert.equal(writer.calls(), 1);
    assert.equal(questions.get(`${READING}:${STUDENT}`)?.length, 3);
    assert.ok(results.every((r) => r.status === "ready" || r.status === "pending"));
    assert.ok(results.some((r) => r.status === "ready"));
    // Once landed, everyone gets the same set.
    const again = await getOrCreateStudentQuestionsWith(READING, STUDENT, { store, write: writer.write, newToken });
    assert.equal(again.status, "ready");
    assert.equal(writer.calls(), 1);
  });

  it("keeps students separate", async () => {
    const { store } = fakeStore();
    const writer = fakeWriter();
    await Promise.all(
      ["s1", "s2", "s3"].flatMap((s) =>
        [1, 2].map(() => getOrCreateStudentQuestionsWith(READING, s, { store, write: writer.write, newToken })),
      ),
    );
    assert.equal(writer.calls(), 3);
  });

  it("returns not_found without calling the model", async () => {
    const { store } = fakeStore({ published: false });
    const writer = fakeWriter();
    assert.deepEqual(
      await getOrCreateStudentQuestionsWith(READING, STUDENT, { store, write: writer.write, newToken }),
      { status: "not_found" },
    );
    assert.equal(writer.calls(), 0);
  });

  it("returns not_allowed for a student outside the class, without claiming", async () => {
    const { store, claims } = fakeStore({ inClass: false });
    const writer = fakeWriter();
    assert.deepEqual(
      await getOrCreateStudentQuestionsWith(READING, STUDENT, { store, write: writer.write, newToken }),
      { status: "not_allowed" },
    );
    assert.equal(writer.calls(), 0);
    assert.equal(claims.size, 0);
  });

  it("releases the claim on a model failure, so the next open tries again", async () => {
    const { store, claims } = fakeStore();
    const logged: Record<string, unknown>[] = [];
    const failing = fakeWriter(new Anthropic.RateLimitError(429, {}, "x", new Headers()));
    const result = await getOrCreateStudentQuestionsWith(READING, STUDENT, {
      store,
      write: failing.write,
      newToken,
      onError: (f) => logged.push(f),
    });
    assert.deepEqual(result, {
      status: "error",
      kind: "busy",
      message: "Question writing is busy right now. Try again in a minute.",
    });
    assert.equal(claims.size, 0);
    assert.equal(logged[0].status, 429);
    const ok = fakeWriter();
    const retry = await getOrCreateStudentQuestionsWith(READING, STUDENT, { store, write: ok.write, newToken });
    assert.equal(retry.status, "ready");
    assert.equal(ok.calls(), 1);
  });

  it("leaves a fresh pending claim alone and returns pending", async () => {
    const { store, claims } = fakeStore();
    claims.set(`${READING}:${STUDENT}`, { token: "other", status: "pending", claimedAt: 0 });
    const writer = fakeWriter();
    const result = await getOrCreateStudentQuestionsWith(READING, STUDENT, { store, write: writer.write, newToken });
    assert.equal(result.status, "pending");
    assert.equal(writer.calls(), 0);
  });

  it("takes over a stale claim, and the old holder can't save", async () => {
    const { store, claims, advance, questions } = fakeStore();
    claims.set(`${READING}:${STUDENT}`, { token: "dead", status: "pending", claimedAt: 0 });
    advance(CLAIM_STALE_SECONDS + 1);
    const writer = fakeWriter();
    const result = await getOrCreateStudentQuestionsWith(READING, STUDENT, { store, write: writer.write, newToken });
    assert.equal(result.status, "ready");
    assert.equal(writer.calls(), 1);
    assert.equal(await store.commit(READING, STUDENT, "dead", ["X?", "Y?", "Z?"]), false);
    assert.deepEqual(questions.get(`${READING}:${STUDENT}`)?.map((q) => q.prompt), ["A?", "B?", "C?"]);
  });

  it("never regenerates once done, even if the cache read raced", async () => {
    const { store, claims } = fakeStore();
    claims.set(`${READING}:${STUDENT}`, { token: "old", status: "done", claimedAt: 0 });
    const writer = fakeWriter();
    const result = await getOrCreateStudentQuestionsWith(READING, STUDENT, { store, write: writer.write, newToken });
    assert.equal(writer.calls(), 0);
    assert.equal(result.status, "pending");
  });
});

describe("the Try again throttle", () => {
  const open = (store: StudentQuestionStore, write: () => Promise<string[]>, configured?: boolean) =>
    getOrCreateStudentQuestionsWith(READING, STUDENT, { store, write, newToken, configured });

  it("is 3 calls per student per reading per 10 minutes, 6 for all time, with kind copy", () => {
    assert.equal(STUDENT_GENERATION_WINDOW_LIMIT, 3);
    assert.equal(STUDENT_GENERATION_WINDOW_MINUTES, 10);
    assert.equal(STUDENT_GENERATION_CALL_LIMIT, 6);
    assert.equal(STUDENT_GENERATION_THROTTLED_MESSAGE, "Let’s take a little break. Try again in a few minutes.");
  });

  it("stops calling the model after the window limit, then allows more after the window", async () => {
    const { store, advance } = fakeStore();
    const failing = fakeWriter(new Error("boom"), 1);
    for (let i = 0; i < STUDENT_GENERATION_WINDOW_LIMIT; i++) {
      assert.equal((await open(store, failing.write)).status, "error");
    }
    assert.deepEqual(await open(store, failing.write), { status: "throttled" });
    assert.equal(failing.calls(), STUDENT_GENERATION_WINDOW_LIMIT);
    advance(STUDENT_GENERATION_WINDOW_MINUTES * 60 + 1);
    const ok = fakeWriter();
    assert.equal((await open(store, ok.write)).status, "ready");
    assert.equal(ok.calls(), 1);
  });

  it("makes exactly the window limit of calls for a burst of 20 Try agains", async () => {
    const { store, calls } = fakeStore();
    const failing = fakeWriter(new Error("boom"), 3);
    // Each request retries while pending, like the page does, until it
    // gets an answer.
    const tryUntilAnswered = async () => {
      for (;;) {
        const r = await open(store, failing.write);
        if (r.status !== "pending") return r;
        await tick();
      }
    };
    const results = await Promise.all(Array.from({ length: 20 }, tryUntilAnswered));
    assert.equal(failing.calls(), STUDENT_GENERATION_WINDOW_LIMIT);
    assert.equal(calls.get(`${READING}:${STUDENT}`)?.length, STUDENT_GENERATION_WINDOW_LIMIT);
    assert.equal(results.filter((r) => r.status === "error").length, STUDENT_GENERATION_WINDOW_LIMIT);
    assert.equal(results.filter((r) => r.status === "throttled").length, 20 - STUDENT_GENERATION_WINDOW_LIMIT);
  });

  it("stops for good at the lifetime cap, with no model call", async () => {
    const { store, advance } = fakeStore();
    const failing = fakeWriter(new Error("boom"), 1);
    for (let i = 0; i < STUDENT_GENERATION_CALL_LIMIT; i++) {
      if (i > 0 && i % STUDENT_GENERATION_WINDOW_LIMIT === 0) advance(STUDENT_GENERATION_WINDOW_MINUTES * 60 + 1);
      assert.equal((await open(store, failing.write)).status, "error");
    }
    advance(24 * 60 * 60);
    const ok = fakeWriter();
    assert.deepEqual(await open(store, ok.write), { status: "calls_used_up" });
    assert.equal(ok.calls(), 0);
  });

  it("counts a stale takeover as a call, and refuses it at the throttle", async () => {
    const { store, claims, calls, advance } = fakeStore();
    calls.set(`${READING}:${STUDENT}`, [0, 0, 0]);
    claims.set(`${READING}:${STUDENT}`, { token: "dead", status: "pending", claimedAt: 0 });
    advance(CLAIM_STALE_SECONDS + 1);
    const writer = fakeWriter();
    assert.deepEqual(await open(store, writer.write), { status: "throttled" });
    assert.equal(writer.calls(), 0);
    advance(STUDENT_GENERATION_WINDOW_MINUTES * 60);
    assert.equal((await open(store, writer.write)).status, "ready");
    assert.equal(calls.get(`${READING}:${STUDENT}`)?.length, 4);
  });

  it("doesn't count cached opens or waiting losers", async () => {
    const { store, calls } = fakeStore();
    const writer = fakeWriter(["A?", "B?", "C?"], 10);
    await Promise.all(Array.from({ length: 10 }, () => open(store, writer.write)));
    for (let i = 0; i < 10; i++) assert.equal((await open(store, writer.write)).status, "ready");
    assert.equal(calls.get(`${READING}:${STUDENT}`)?.length, 1);
  });

  it("without a model key, fails before claiming, so nothing is counted", async () => {
    const { store, calls, claims } = fakeStore();
    const writer = fakeWriter();
    const result = await open(store, writer.write, false);
    assert.equal(result.status, "error");
    assert.equal(result.status === "error" && result.kind, "not_configured");
    assert.equal(writer.calls(), 0);
    assert.equal(calls.size, 0);
    assert.equal(claims.size, 0);
  });
});

describe("per-reading cap", () => {
  const LIMIT = STUDENT_SETS_PER_READING_LIMIT;
  const students = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `s${from + i}`);
  const open = (store: StudentQuestionStore, write: () => Promise<string[]>, s: string) =>
    getOrCreateStudentQuestionsWith(READING, s, { store, write, newToken });

  it("is 150 sets, with a plain message", () => {
    assert.equal(LIMIT, 150);
    assert.equal(STUDENT_SETS_LIMITED_MESSAGE, "Ask your teacher for help with this one.");
  });

  it("allows sets under the cap and refuses new students at it", async () => {
    const { store, questions } = fakeStore();
    const writer = fakeWriter(["A?", "B?", "C?"], 1);
    const results = await Promise.all(students(LIMIT + 50).map((s) => open(store, writer.write, s)));
    assert.equal(results.filter((r) => r.status === "ready").length, LIMIT);
    assert.equal(results.filter((r) => r.status === "limit_reached").length, 50);
    assert.equal(writer.calls(), LIMIT);
    assert.equal(questions.size, LIMIT);
  });

  it("still serves a student who already has a set at the cap", async () => {
    const { store } = fakeStore();
    const writer = fakeWriter(["A?", "B?", "C?"], 1);
    await Promise.all(students(LIMIT).map((s) => open(store, writer.write, s)));
    const again = await open(store, writer.write, "s0");
    assert.equal(again.status, "ready");
    assert.equal(writer.calls(), LIMIT);
  });

  it("lets a stale claim be taken over at the cap", async () => {
    const { store, claims, advance } = fakeStore();
    for (const s of students(LIMIT)) {
      claims.set(`${READING}:${s}`, { token: "dead", status: "pending", claimedAt: 0 });
    }
    advance(CLAIM_STALE_SECONDS + 1);
    const writer = fakeWriter();
    assert.equal((await open(store, writer.write, "s7")).status, "ready");
    assert.equal((await open(store, writer.write, "new")).status, "limit_reached");
    assert.equal(writer.calls(), 1);
  });

  it("frees the slot when a model failure releases the claim", async () => {
    const { store, claims } = fakeStore();
    for (const s of students(LIMIT - 1)) {
      claims.set(`${READING}:${s}`, { token: "x", status: "done", claimedAt: 0 });
    }
    const failing = fakeWriter(new Error("boom"));
    assert.equal((await open(store, failing.write, "last")).status, "error");
    assert.equal(claims.size, LIMIT - 1);
    const ok = fakeWriter();
    assert.equal((await open(store, ok.write, "other")).status, "ready");
    assert.equal((await open(store, ok.write, "last")).status, "limit_reached");
  });

  it("counts per reading", async () => {
    const { store, claims } = fakeStore();
    for (const s of students(LIMIT)) {
      claims.set(`other:${s}`, { token: "x", status: "done", claimedAt: 0 });
    }
    const writer = fakeWriter();
    assert.equal((await open(store, writer.write, "s0")).status, "ready");
  });
});

describe("studentFacingResult", () => {
  it("shows not_allowed exactly like not_found", () => {
    assert.deepEqual(studentFacingResult({ status: "not_allowed" }), { status: "not_found" });
    assert.deepEqual(studentFacingResult({ status: "not_found" }), { status: "not_found" });
  });

  it("passes every other result through unchanged", () => {
    const results: StudentQuestionsResult[] = [
      { status: "ready", questions: [{ id: "q1", position: 1, prompt: "Why?" }] },
      { status: "pending", retryAfterMs: 2_000 },
      { status: "limit_reached" },
      { status: "error", kind: "timeout", message: "m" },
    ];
    for (const r of results) assert.equal(studentFacingResult(r), r);
  });
});

describe("stale claim timeout", () => {
  it("outlasts the write deadline, with margin", () => {
    assert.equal(QUESTION_WRITE_DEADLINE_MS, 110_000);
    assert.ok(CLAIM_STALE_SECONDS * 1000 >= QUESTION_WRITE_DEADLINE_MS + 30_000);
  });
});

describe("student question statements", () => {
  it("only finds published per-student readings, and says if the student is in the class", () => {
    const s = studentContextStatement(READING, STUDENT);
    assert.match(s.text, /s\.id = \$2::uuid and s\.class_id = r\.class_id\s+\) as in_class/);
    assert.match(s.text, /r\.status = 'published' and r\.question_mode = 'per_student'/);
  });

  it("claims under the reading lock, in class, under the cap, insert-if-absent", () => {
    const [lock, insert, , why] = claimStatements(READING, STUDENT, "t", 150);
    assert.equal(lock.text, "select id from readings where id = $1::uuid for no key update");
    assert.match(insert.text, /join students s on s\.class_id = r\.class_id/);
    assert.match(insert.text, /r\.status = 'published' and r\.question_mode = 'per_student'/);
    assert.match(
      insert.text,
      /\(select count\(\*\) from question_generations where reading_id = \$1::uuid\) < \$4::int/,
    );
    assert.match(insert.text, /on conflict do nothing\s+returning claim_token$/);
    assert.deepEqual(insert.params, [READING, STUDENT, "t", 150, 10, 3, 6]);
    assert.match(why.text, /as has_claim/);
    assert.match(why.text, /r\.status = 'published' and r\.question_mode = 'per_student'\s+\) as eligible/);
    assert.match(why.text, /as claims/);
    assert.match(why.text, /as recent_calls/);
    assert.match(why.text, /as all_calls/);
    assert.deepEqual(why.params, [READING, STUDENT, 10]);
  });

  it("claims only under the throttle, and records the call only with its own claim", () => {
    const [, insert, record] = claimStatements(READING, STUDENT, "t", 150);
    assert.match(
      insert.text,
      /from student_question_calls\s+where reading_id = \$1::uuid and student_id = \$2::uuid\s+and created_at > now\(\) - make_interval\(mins => \$5::int\)\) < \$6::int/,
    );
    assert.match(insert.text, /where reading_id = \$1::uuid and student_id = \$2::uuid\) < \$7::int/);
    assert.match(record.text, /^insert into student_question_calls \(reading_id, student_id\)/);
    assert.match(record.text, /claim_token = \$3::uuid and status = 'pending'/);
    assert.deepEqual(record.params, [READING, STUDENT, "t"]);
  });

  it("reads the claim outcome", () => {
    const claimed = [[{ id: READING }], [{ claim_token: "t" }], [{ id: "c" }], [{ has_claim: true, claims: 150 }]];
    assert.equal(claimOutcome(claimed, 150), "claimed");
    assert.equal(claimOutcome([[{}], [], [], [{ has_claim: true, eligible: false, claims: 150 }]], 150), "exists");
    assert.equal(claimOutcome([[{}], [], [], [{ has_claim: false, eligible: true, claims: 150 }]], 150), "limit_reached");
    assert.equal(claimOutcome([[{}], [], [], [{ has_claim: false, eligible: true, claims: 149 }]], 150), "refused");
    assert.equal(claimOutcome([[], [], [], [{ has_claim: false, eligible: false, claims: 0 }]], 150), "refused");
  });

  it("reads the throttle from the claim outcome, lifetime first", () => {
    const row = (recent: number, all: number) => [[{}], [], [], [{ has_claim: false, eligible: true, claims: 1, recent_calls: recent, all_calls: all }]];
    assert.equal(claimOutcome(row(3, 3), 150), "throttled");
    assert.equal(claimOutcome(row(0, 6), 150), "calls_used_up");
    assert.equal(claimOutcome(row(3, 6), 150), "calls_used_up");
    assert.equal(claimOutcome(row(2, 5), 150), "refused");
  });

  it("refuses a student who doesn't qualify even at the cap", () => {
    assert.equal(claimOutcome([[{}], [], [], [{ has_claim: false, eligible: false, claims: 150 }]], 150), "refused");
    assert.equal(claimOutcome([[{}], [], [], [{ has_claim: false, claims: 150 }]], 150), "refused");
  });

  it("takes over only stale pending claims, under the reading lock and the throttle, recording the call", () => {
    const [lock, s] = takeOverStatements(READING, STUDENT, "t", 150);
    assert.equal(lock.text, "select id from readings where id = $1::uuid for no key update");
    assert.match(s.text, /status = 'pending'/);
    assert.match(s.text, /claimed_at < now\(\) - make_interval\(secs => \$4::int\)/);
    assert.match(s.text, /\(select recent_calls from calls\) < \$6::int/);
    assert.match(s.text, /\(select all_calls from calls\) < \$7::int/);
    assert.match(s.text, /insert into student_question_calls \(reading_id, student_id\)\s+select \$1::uuid, \$2::uuid from taken/);
    assert.deepEqual(s.params, [READING, STUDENT, "t", 150, 10, 3, 6]);
  });

  it("reads the takeover outcome", () => {
    const out = (row: Record<string, unknown>) => takeOverOutcome([[{}], [row]]);
    assert.equal(out({ taken: 1, stale: true, recent_calls: 0, all_calls: 0 }), "taken");
    assert.equal(out({ taken: 0, stale: false, recent_calls: 3, all_calls: 6 }), "not_stale");
    assert.equal(out({ taken: 0, stale: true, recent_calls: 3, all_calls: 3 }), "throttled");
    assert.equal(out({ taken: 0, stale: true, recent_calls: 0, all_calls: 6 }), "calls_used_up");
    assert.equal(takeOverOutcome([[], []]), "not_stale");
  });

  it("releases only its own pending claim", () => {
    assert.match(releaseStatement(READING, STUDENT, "t").text, /claim_token = \$3::uuid and status = 'pending'/);
  });

  it("commits the claim and the set together, on the token", () => {
    const [done, insert] = commitStatements(READING, STUDENT, "t", ["A?", "B?"]);
    assert.match(done.text, /set status = 'done'/);
    assert.match(done.text, /claim_token = \$3::uuid and status = 'pending'/);
    assert.match(insert.text, /claim_token = \$3::uuid and status = 'done'/);
    assert.deepEqual(insert.params.slice(3), [[1, 2], ["A?", "B?"]]);
  });
});
