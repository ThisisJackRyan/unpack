import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import {
  CLAIM_STALE_SECONDS,
  claimStatement,
  commitStatements,
  getOrCreateStudentQuestionsWith,
  releaseStatement,
  studentContextStatement,
  takeOverStatement,
  type StudentQuestion,
  type StudentQuestionStore,
} from "./student-questions-core";
import { QUESTION_WRITE_MAX_MS } from "./ai/settings";

const READING = "r1";
const STUDENT = "s1";
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

// In-memory store with the same rules as the Postgres one: claim is an
// atomic insert-if-absent, commit is all-or-nothing on the token. Every call
// yields first, so concurrent callers interleave.
function fakeStore(options: { published?: boolean; count?: number } = {}) {
  const claims = new Map<string, { token: string; status: "pending" | "done"; claimedAt: number }>();
  const questions = new Map<string, StudentQuestion[]>();
  let now = 0;
  let ids = 0;
  const key = (r: string, s: string) => `${r}:${s}`;
  const store: StudentQuestionStore = {
    async loadContext() {
      await tick();
      if (options.published === false) return undefined;
      return { bodyText: "text", gradeLevel: "4", questionCount: options.count ?? 3 };
    },
    async readQuestions(r, s) {
      await tick();
      return questions.get(key(r, s)) ?? [];
    },
    async claim(r, s, token) {
      await tick();
      if (claims.has(key(r, s))) return false;
      claims.set(key(r, s), { token, status: "pending", claimedAt: now });
      return true;
    },
    async takeOverStale(r, s, token, staleSeconds) {
      await tick();
      const c = claims.get(key(r, s));
      if (!c || c.status !== "pending" || now - c.claimedAt <= staleSeconds) return false;
      claims.set(key(r, s), { token, status: "pending", claimedAt: now });
      return true;
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

describe("stale claim timeout", () => {
  it("outlasts the longest a live writer can take", () => {
    assert.ok(CLAIM_STALE_SECONDS * 1000 > QUESTION_WRITE_MAX_MS);
  });
});

describe("student question statements", () => {
  it("only finds published per-student readings in the student's class", () => {
    const s = studentContextStatement(READING, STUDENT);
    assert.match(s.text, /join students s on s\.class_id = r\.class_id/);
    assert.match(s.text, /r\.status = 'published' and r\.question_mode = 'per_student'/);
  });

  it("claims with insert-if-absent", () => {
    assert.match(claimStatement(READING, STUDENT, "t").text, /on conflict do nothing\s+returning claim_token$/);
  });

  it("takes over only pending claims older than the timeout", () => {
    const s = takeOverStatement(READING, STUDENT, "t", 150);
    assert.match(s.text, /status = 'pending'/);
    assert.match(s.text, /claimed_at < now\(\) - make_interval\(secs => \$4::int\)/);
    assert.deepEqual(s.params, [READING, STUDENT, "t", 150]);
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
