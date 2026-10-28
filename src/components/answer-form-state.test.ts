import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, type TestContext } from "node:test";
import { EFFORT_CHECK_DEADLINE_MS } from "@/lib/ai/settings";
import { PRE_CHECK_DEADLINE_MS } from "@/lib/answer-check-guard";
import { CHECK_TIMED_OUT_MESSAGE } from "@/lib/validate-answers";
import {
  APP_UPDATED_MESSAGE,
  APP_UPDATED_STATE,
  CHECK_NO_REPLY_MESSAGE,
  CLIENT_CHECK_TIMEOUT_MS,
  isAppUpdatedError,
  isNextRedirect,
  NO_REPLY_STATE,
  submitCheck,
  TIMED_OUT_STATE,
  withCheckFallback,
  type AnswerFormState,
  valuesForNewTry,
  type CheckRun,
} from "./answer-form-state";

// Stands in for next/navigation's unstable_rethrow: lets an error with a
// NEXT_ digest (redirect, not found) through, like Next's own check.
function rethrowNext(error: unknown) {
  const digest = (error as { digest?: unknown } | null)?.digest;
  if (typeof digest === "string" && digest.startsWith("NEXT_")) throw error;
}

function formWithAnswers() {
  const data = new FormData();
  data.set("answer:q1", "to see the snow");
  data.set("answer:q2", "it ran away");
  return data;
}

// The fallback logs the error; keep the test output clean, and let a test
// see what was logged.
function quietErrors(t: TestContext) {
  return t.mock.method(console, "error", () => {});
}

// A request the test settles by hand.
function deferred() {
  let resolve: (state: AnswerFormState) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<AnswerFormState>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Next's own error for a server action a deploy removed
// (next/dist/client/components/unrecognized-action-error.js).
class UnrecognizedActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnrecognizedActionError";
  }
}

describe("withCheckFallback", () => {
  it("passes the action's state through", async () => {
    const state: AnswerFormState = { message: "Some answers need a fix. Look below.", errors: { q1: "x" } };
    const action = withCheckFallback(async () => state, rethrowNext);
    assert.equal(await action({}, formWithAnswers()), state);
    // The server's timeout keeps its own message.
    const timedOut = withCheckFallback(async () => TIMED_OUT_STATE, rethrowNext);
    assert.equal((await timedOut({}, formWithAnswers())).message, CHECK_TIMED_OUT_MESSAGE);
  });

  it("turns a failed request (connection closed, 504) into the no-reply message, and logs the error only", async (t) => {
    const logged = quietErrors(t);
    for (const failure of [new TypeError("Failed to fetch"), new Error("An unexpected response was received from the server.")]) {
      const action = withCheckFallback(async () => {
        throw failure;
      }, rethrowNext);
      const state = await action({ errors: { q1: "old" } }, formWithAnswers());
      assert.equal(state, NO_REPLY_STATE);
      // No stale field errors, and nothing about the answers: the form
      // keeps them, as it does after any check that saved no try.
      assert.equal("errors" in state, false);
      assert.deepEqual(logged.mock.calls.at(-1)?.arguments, [failure]);
    }
    assert.deepEqual(NO_REPLY_STATE, {
      message: "We couldn’t hear back. Your answers are still here. Reload the page to see if they were checked.",
    });
    // The form can't know whether the check was saved.
    assert.doesNotMatch(CHECK_NO_REPLY_MESSAGE, /didn’t use up a try/);
    assert.equal(TIMED_OUT_STATE.message, "That took too long. Try again. This didn’t use up a try.");
  });

  it("says unpack was updated when the server no longer has the action (a deploy since the page loaded)", async (t) => {
    quietErrors(t);
    const skew = new UnrecognizedActionError('Server Action "7f3a" was not found on the server.');
    const action = withCheckFallback(async () => {
      throw skew;
    }, rethrowNext);
    assert.equal(await action({}, formWithAnswers()), APP_UPDATED_STATE);
    assert.deepEqual(APP_UPDATED_STATE, { message: "unpack was just updated. Reload the page to keep going." });
    assert.equal(APP_UPDATED_MESSAGE, "unpack was just updated. Reload the page to keep going.");
  });

  it("leaves the posted answers alone", async (t) => {
    quietErrors(t);
    const data = formWithAnswers();
    const action = withCheckFallback(async () => {
      throw new TypeError("Failed to fetch");
    }, rethrowNext);
    await action({}, data);
    assert.deepEqual([...data.entries()], [
      ["answer:q1", "to see the snow"],
      ["answer:q2", "it ran away"],
    ]);
  });

  it("lets Next's redirect through, so a missing session still goes to /join", async (t) => {
    const logged = quietErrors(t);
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;push;/join;307;" });
    const action = withCheckFallback(async () => {
      throw redirect;
    }, rethrowNext);
    await assert.rejects(action({}, formWithAnswers()), (e: unknown) => e === redirect);
    assert.equal(logged.mock.callCount(), 0);
  });

  describe("the client timeout", () => {
    it("stops waiting after CLIENT_CHECK_TIMEOUT_MS: the no-reply state, and the late result is ignored", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const request = deferred();
      const data = formWithAnswers();
      const action = withCheckFallback(() => request.promise, rethrowNext);
      let settled: AnswerFormState | undefined;
      const pending = action({}, data).then((s) => (settled = s));

      t.mock.timers.tick(CLIENT_CHECK_TIMEOUT_MS - 1);
      await Promise.resolve();
      assert.equal(settled, undefined, "still waiting just before the bound");

      t.mock.timers.tick(1);
      await pending;
      // The wrapper has returned, so submitCheck clears pending and the
      // button comes back.
      assert.equal(settled, NO_REPLY_STATE);
      assert.deepEqual([...data.entries()].length, 2, "the answers are untouched");

      // A late success, then a late failure: neither reaches the state.
      request.resolve({});
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, NO_REPLY_STATE);
    });

    it("a late rejection after the timeout is ignored too (no unhandled rejection, nothing logged)", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const logged = quietErrors(t);
      const request = deferred();
      const pending = withCheckFallback(() => request.promise, rethrowNext)({}, formWithAnswers());
      t.mock.timers.tick(CLIENT_CHECK_TIMEOUT_MS);
      assert.equal(await pending, NO_REPLY_STATE);
      request.reject(new TypeError("Failed to fetch"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(logged.mock.callCount(), 0);
    });

    it("a result before the bound passes through, and the timer is cleared", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const request = deferred();
      const pending = withCheckFallback(() => request.promise, rethrowNext)({}, formWithAnswers());
      t.mock.timers.tick(CLIENT_CHECK_TIMEOUT_MS / 2);
      const state = { message: "x" };
      request.resolve(state);
      assert.equal(await pending, state);
      // Nothing left to fire.
      t.mock.timers.tick(CLIENT_CHECK_TIMEOUT_MS);
    });

    it("a rejection before the bound still maps to the fallback, and a redirect still passes", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      quietErrors(t);
      const failed = deferred();
      const pending = withCheckFallback(() => failed.promise, rethrowNext)({}, formWithAnswers());
      failed.reject(new TypeError("Failed to fetch"));
      assert.equal(await pending, NO_REPLY_STATE);

      const redirected = deferred();
      const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;push;/join;307;" });
      const toJoin = withCheckFallback(() => redirected.promise, rethrowNext)({}, formWithAnswers());
      redirected.reject(redirect);
      await assert.rejects(toJoin, (e: unknown) => e === redirect);
    });

    it("waits past the server's worst case and stops well before the pages' maxDuration", () => {
      // The lookups, the check, then the commit, re-render, a cold start,
      // and the network: at least 15s for those.
      const serverWorstCase = PRE_CHECK_DEADLINE_MS + EFFORT_CHECK_DEADLINE_MS + 15_000;
      assert.ok(CLIENT_CHECK_TIMEOUT_MS >= serverWorstCase, `${CLIENT_CHECK_TIMEOUT_MS} >= ${serverWorstCase}`);
      for (const page of ["src/app/c/r/[readingId]/page.tsx", "src/app/learn/r/[readingId]/page.tsx"]) {
        const match = readFileSync(page, "utf8").match(/^export const maxDuration = (\d+);$/m);
        assert.ok(match, `${page} sets maxDuration`);
        assert.ok(CLIENT_CHECK_TIMEOUT_MS + 30_000 <= Number(match[1]) * 1000, `${page}: well under maxDuration`);
      }
    });
  });
});

describe("isAppUpdatedError", () => {
  it("matches Next 16's errors for a server action the server no longer has", () => {
    assert.ok(isAppUpdatedError(new UnrecognizedActionError('Server Action "abc" was not found on the server.')));
    assert.ok(
      isAppUpdatedError(
        new Error(
          "Failed to find Server Action. This request might be from an older or newer deployment.\nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action",
        ),
      ),
    );
    // A forwarded action's 404, text/plain.
    assert.ok(isAppUpdatedError(new Error("Server action not found.")));
  });

  it("doesn't match any other failure", () => {
    for (const other of [
      new TypeError("Failed to fetch"),
      new Error("An unexpected response was received from the server."),
      new Error("Internal Server Error"),
      "Failed to find Server Action",
      null,
      undefined,
    ]) {
      assert.equal(isAppUpdatedError(other), false, String(other));
    }
  });
});

describe("isNextRedirect", () => {
  it("matches Next's redirect digest only", () => {
    assert.ok(isNextRedirect(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;push;/join;307;" })));
    assert.ok(isNextRedirect({ digest: "NEXT_REDIRECT;replace;/sign-in;303;" }));
    for (const other of [
      { digest: "NEXT_HTTP_ERROR_FALLBACK;404" },
      new Error("NEXT_REDIRECT"),
      new TypeError("Failed to fetch"),
      null,
      undefined,
    ]) {
      assert.equal(isNextRedirect(other), false, String(other));
    }
  });
});

describe("submitCheck", () => {
  // Records what the form would do with each handler.
  function recorder() {
    const events: string[] = [];
    const states: AnswerFormState[] = [];
    const errors: unknown[] = [];
    return {
      events,
      states,
      errors,
      on: {
        start: () => events.push("start"),
        result: (state: AnswerFormState) => {
          events.push("result");
          states.push(state);
        },
        error: (error: unknown) => {
          events.push("error");
          errors.push(error);
        },
      },
    };
  }

  it("starts, then applies the result and clears pending", async () => {
    const run: CheckRun = { seq: 0, pending: false };
    const r = recorder();
    const request = deferred();
    const done = submitCheck(run, () => request.promise, r.on);
    assert.deepEqual(r.events, ["start"]);
    assert.equal(run.pending, true);
    const state = { message: "x" };
    request.resolve(state);
    await done;
    assert.deepEqual(r.events, ["start", "result"]);
    assert.equal(r.states[0], state);
    assert.equal(run.pending, false);
  });

  it("refuses a second submit while one is running", async () => {
    const run: CheckRun = { seq: 0, pending: false };
    const r = recorder();
    const request = deferred();
    let calls = 0;
    const check = () => {
      calls += 1;
      return request.promise;
    };
    const first = submitCheck(run, check, r.on);
    await submitCheck(run, check, r.on);
    assert.equal(calls, 1);
    assert.deepEqual(r.events, ["start"]);
    request.resolve({});
    await first;
  });

  it("drops the result and the error of a superseded submit", async () => {
    const run: CheckRun = { seq: 0, pending: false };
    const r = recorder();
    const old = deferred();
    const oldDone = submitCheck(run, () => old.promise, r.on);
    // Something moved the sequence on (a newer submit).
    run.seq += 1;
    run.pending = false;
    old.resolve({ message: "late" });
    await oldDone;
    assert.deepEqual(r.events, ["start"]);

    const failed = deferred();
    const failedDone = submitCheck(run, () => failed.promise, r.on);
    run.seq += 1;
    failed.reject(new Error("late failure"));
    await failedDone;
    assert.deepEqual(r.events, ["start", "start"]);
  });

  it("with withCheckFallback: the timeout shows at the bound, and the late result never arrives", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const run: CheckRun = { seq: 0, pending: false };
    const r = recorder();
    const request = deferred();
    const check = withCheckFallback(() => request.promise, rethrowNext, 2_000);
    const done = submitCheck(run, () => check({}, formWithAnswers()), r.on);
    t.mock.timers.tick(2_000);
    await done;
    assert.deepEqual(r.states, [NO_REPLY_STATE]);
    assert.equal(run.pending, false, "the button comes back");
    request.resolve({ message: "late" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(r.states, [NO_REPLY_STATE]);
  });

  it("leaves a redirect to Next's router (stays pending) and passes other Next errors to the form", async () => {
    const run: CheckRun = { seq: 0, pending: false };
    const r = recorder();
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;push;/join;307;" });
    await submitCheck(run, () => Promise.reject(redirect), r.on);
    assert.deepEqual(r.events, ["start"]);
    assert.equal(run.pending, true, "no flash of the idle form before the page goes");

    const fresh: CheckRun = { seq: 0, pending: false };
    const notFound = Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    await submitCheck(fresh, () => Promise.reject(notFound), r.on);
    assert.equal(r.errors[0], notFound);
    assert.equal(fresh.pending, false);
  });
});

describe("valuesForNewTry", () => {
  const checked = { q1: "to see the snow", q2: "it ran away" };

  it("starts the new try from the answers just checked when nothing was typed since the submit", () => {
    assert.deepEqual(valuesForNewTry(checked, checked, false), checked);
    // Even when the boxes differ (restored drafts, say), no edit since the
    // submit means the checked answers win.
    assert.deepEqual(valuesForNewTry(checked, { q1: "older", q2: "" }, false), checked);
  });

  it("keeps what the student typed after the form gave up, when the late check lands", () => {
    const typed = { q1: "to see the snow, and play in it", q2: "it ran away" };
    assert.deepEqual(valuesForNewTry(checked, typed, true), typed);
  });

  it("fills a question the boxes don't have from the new try", () => {
    assert.deepEqual(valuesForNewTry(checked, { q1: "mine" }, true), { q1: "mine", q2: "it ran away" });
  });
});
