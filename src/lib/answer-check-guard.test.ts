import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TIMED_OUT_STATE, type AnswerFormState } from "@/components/answer-form-state";
import {
  DeadlineError,
  guardAnswerCheck,
  PRE_CHECK_DEADLINE_MS,
  SUBMIT_FAILED_MESSAGE,
  withDeadline,
} from "./answer-check-guard";
import { submitAnswersWith, type AttemptStore, type EffortChecker } from "./submit-answers-core";

// Stands in for next/navigation's unstable_rethrow (see
// answer-form-state.test.ts).
function rethrowNext(error: unknown) {
  const digest = (error as { digest?: unknown } | null)?.digest;
  if (typeof digest === "string" && digest.startsWith("NEXT_")) throw error;
}

const redirectError = () => Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;push;/join;307;" });
const never = <T>() => new Promise<T>(() => {});

// Records every write, so a test can say nothing was claimed or saved.
function recordingStore(loadContext: AttemptStore["loadContext"]) {
  const writes: string[] = [];
  const store: AttemptStore = {
    loadContext,
    async claim() {
      writes.push("claim");
      return "claimed";
    },
    async release() {
      writes.push("release");
    },
    async commit() {
      writes.push("commit");
      return 1;
    },
  };
  return { store, writes };
}

const passAll: EffortChecker = async (input) => input.items.map((i) => ({ questionId: i.questionId, pass: true, nudge: "" }));

// The action's shape: the session lookup, then the submit, each under the
// pre-check signal.
function action(session: () => Promise<{ id: string } | null>, store: AttemptStore) {
  return async (preCheck: AbortSignal): Promise<AnswerFormState> => {
    const s = await withDeadline(session(), preCheck);
    if (!s) throw redirectError();
    const r = await submitAnswersWith(s.id, "r1", [{ questionId: "q1", value: "to see the snow" }], {
      store,
      check: passAll,
      newId: () => "c1",
      preCheck,
    });
    return r.status === "checked" ? {} : { message: r.status };
  };
}

// AbortSignal.timeout's timer doesn't hold the event loop open.
async function keepingAlive<T>(work: () => Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    return await work();
  } finally {
    clearInterval(keepAlive);
  }
}

describe("guardAnswerCheck", () => {
  it("passes the check's state through", async () => {
    const state = { message: "x" };
    assert.equal(await guardAnswerCheck(async () => state, { rethrow: rethrowNext, onError: () => {} }), state);
  });

  it("a session lookup that throws is a message, logged once, with nothing claimed", async () => {
    const { store, writes } = recordingStore(never);
    const errors: unknown[] = [];
    const down = new Error("fetch failed");
    const state = await guardAnswerCheck(
      action(async () => {
        throw down;
      }, store),
      { rethrow: rethrowNext, onError: (e) => errors.push(e) },
    );
    assert.deepEqual(state, { message: SUBMIT_FAILED_MESSAGE });
    assert.deepEqual(errors, [down]);
    assert.deepEqual(writes, []);
  });

  it("a session lookup that hangs is the timeout message after the deadline, with nothing claimed", async () => {
    const { store, writes } = recordingStore(never);
    const errors: unknown[] = [];
    const state = await keepingAlive(() =>
      guardAnswerCheck(action(never, store), { rethrow: rethrowNext, onError: (e) => errors.push(e), deadlineMs: 20 }),
    );
    assert.equal(state, TIMED_OUT_STATE);
    assert.ok(errors[0] instanceof DeadlineError);
    assert.deepEqual(writes, []);
  });

  it("a reading lookup that throws or hangs before the claim: the same, with no effort_checks row", async () => {
    const thrown = recordingStore(async () => {
      throw Object.assign(new Error("connection terminated"), { code: "57P01" });
    });
    const failed = await guardAnswerCheck(action(async () => ({ id: "s1" }), thrown.store), {
      rethrow: rethrowNext,
      onError: () => {},
    });
    assert.deepEqual(failed, { message: SUBMIT_FAILED_MESSAGE });
    assert.deepEqual(thrown.writes, []);

    const hung = recordingStore(never);
    const timedOut = await keepingAlive(() =>
      guardAnswerCheck(action(async () => ({ id: "s1" }), hung.store), {
        rethrow: rethrowNext,
        onError: () => {},
        deadlineMs: 20,
      }),
    );
    assert.equal(timedOut, TIMED_OUT_STATE);
    assert.deepEqual(hung.writes, []);
  });

  it("lets Next's redirect through, unlogged, so a missing session still goes to /join", async () => {
    const { store } = recordingStore(never);
    const errors: unknown[] = [];
    await assert.rejects(
      guardAnswerCheck(action(async () => null, store), { rethrow: rethrowNext, onError: (e) => errors.push(e) }),
      (e: unknown) => (e as { digest?: string }).digest?.startsWith("NEXT_REDIRECT") === true,
    );
    // And a redirect from inside the deadline (requireSelfLearner's).
    const redirect = redirectError();
    await assert.rejects(
      guardAnswerCheck((preCheck) => withDeadline(Promise.reject(redirect), preCheck), {
        rethrow: rethrowNext,
        onError: (e) => errors.push(e),
      }),
      (e: unknown) => e === redirect,
    );
    assert.deepEqual(errors, []);
  });

  it("keeps the pre-check deadline short: a lookup, not a check", () => {
    assert.ok(PRE_CHECK_DEADLINE_MS >= 5_000 && PRE_CHECK_DEADLINE_MS <= 15_000);
  });
});

describe("withDeadline", () => {
  it("passes a result through before the deadline, and with no signal", async () => {
    assert.equal(await withDeadline(Promise.resolve(1), new AbortController().signal), 1);
    assert.equal(await withDeadline(Promise.resolve(2), undefined), 2);
  });

  it("rejects at once when the deadline already passed", async () => {
    await assert.rejects(withDeadline(never(), AbortSignal.abort()), DeadlineError);
  });

  it("ignores the work's late rejection after the deadline (no unhandled rejection)", async () => {
    const deadline = new AbortController();
    let fail: (e: unknown) => void = () => {};
    const late = withDeadline(new Promise((_, reject) => (fail = reject)), deadline.signal);
    deadline.abort();
    await assert.rejects(late, DeadlineError);
    fail(new Error("too late"));
    await new Promise((resolve) => setTimeout(resolve, 1));
  });
});
