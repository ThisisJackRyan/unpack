import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHECK_TIMED_OUT_MESSAGE } from "@/lib/validate-answers";
import { TIMED_OUT_STATE, withCheckFallback, type AnswerFormState } from "./answer-form-state";

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

describe("withCheckFallback", () => {
  it("passes the action's state through", async () => {
    const state: AnswerFormState = { message: "Some answers need a fix. Look below.", errors: { q1: "x" } };
    const action = withCheckFallback(async () => state, rethrowNext);
    assert.equal(await action({}, formWithAnswers()), state);
  });

  it("turns a failed request (connection closed, 504) into the inline timeout message", async () => {
    for (const failure of [new TypeError("Failed to fetch"), new Error("An unexpected response was received from the server.")]) {
      const action = withCheckFallback(async () => {
        throw failure;
      }, rethrowNext);
      const state = await action({ errors: { q1: "old" } }, formWithAnswers());
      assert.deepEqual(state, { timedOut: true, message: CHECK_TIMED_OUT_MESSAGE });
      // No stale field errors, and nothing about the answers: the form
      // keeps them, as it does after any check that saved no try.
      assert.equal("errors" in state, false);
    }
    assert.deepEqual(TIMED_OUT_STATE, { timedOut: true, message: "That took too long. Try again. This didn’t use up a try." });
  });

  it("leaves the posted answers alone", async () => {
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

  it("lets Next's redirect through, so a missing session still goes to /join", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;push;/join;307;" });
    const action = withCheckFallback(async () => {
      throw redirect;
    }, rethrowNext);
    await assert.rejects(action({}, formWithAnswers()), (e: unknown) => e === redirect);
  });
});
