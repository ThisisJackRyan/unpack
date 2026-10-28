import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { questionPanelFallback } from "@/app/teacher/classes/[id]/readings/[readingId]/question-state";
import { SUBMIT_FAILED_MESSAGE } from "@/lib/answer-check-guard";
import { CREATE_NO_REPLY_MESSAGE } from "@/lib/pending-copy";
import { withRejectionFallback } from "./action-fallback";
import { APP_UPDATED_MESSAGE } from "./answer-form-state";
import { readingFormFallback } from "./reading-form-fallback";
import type { ReadingFormState } from "./reading-form-state";

function rethrowNext(error: unknown) {
  const digest = (error as { digest?: unknown } | null)?.digest;
  if (typeof digest === "string" && digest.startsWith("NEXT_")) throw error;
}

const BODY = "A long passage pasted from a book, with “quotes” and line\nbreaks.\n\nAnd a second paragraph.";

function soloForm(): FormData {
  const data = new FormData();
  data.set("source", "text");
  data.set("url", "");
  data.set("title", " The passage ");
  data.set("bodyText", BODY);
  data.set("gradeLevel", "7");
  data.set("questionCount", "5");
  return data;
}

// Quiet console.error for the duration (the fallback logs the error).
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = original;
  }
}

const unrecognized = () => Object.assign(new Error("Server Action \"abc\" was not found on the server."), { name: "UnrecognizedActionError" });

describe("withRejectionFallback", () => {
  it("passes the action's state through", async () => {
    const action = withRejectionFallback(async () => "ok", () => "fallback", rethrowNext);
    assert.equal(await action("prev", new FormData()), "ok");
  });

  it("a rejected call becomes the fallback (no reply, or app updated), never a rejection", async () => {
    const kinds: string[] = [];
    const fallback = (kind: string) => {
      kinds.push(kind);
      return kind;
    };
    for (const error of [new TypeError("Failed to fetch"), new Error("An unexpected response was received from the server."), unrecognized()]) {
      const action = withRejectionFallback(async () => Promise.reject(error), fallback, rethrowNext);
      await quietly(() => action("prev", new FormData()));
    }
    assert.deepEqual(kinds, ["no_reply", "no_reply", "app_updated"]);
  });

  it("lets Next's redirect and not-found through", async () => {
    for (const digest of ["NEXT_REDIRECT;replace;/learn/r/1;303;", "NEXT_HTTP_ERROR_FALLBACK;404"]) {
      const action = withRejectionFallback(async () => Promise.reject(Object.assign(new Error("next"), { digest })), () => "fallback", rethrowNext);
      await assert.rejects(action("prev", new FormData()), (e: unknown) => (e as { digest?: string }).digest === digest);
    }
  });
});

describe("readingFormFallback", () => {
  it("a create with no reply: the pending no-reply message, every value back in the fields", async () => {
    for (const mode of ["solo", "create"] as const) {
      const action = withRejectionFallback<ReadingFormState>(
        async () => Promise.reject(new TypeError("Failed to fetch")),
        (kind, formData) => readingFormFallback(mode, kind, formData),
        rethrowNext,
      );
      const state = await quietly(() => action({}, soloForm()));
      assert.equal(state.errors?.form, CREATE_NO_REPLY_MESSAGE);
      assert.equal(state.values?.bodyText, BODY, "the pasted text, as typed");
      assert.equal(state.values?.title, "The passage");
      assert.equal(state.values?.gradeLevel, "7");
      assert.equal(state.values?.questionCount, "5");
      assert.equal(state.values?.source, "text");
    }
  });

  it("an edit with no reply: \"Something went wrong. Try again.\" (an edit is safe to repeat)", () => {
    for (const mode of ["edit", "title"] as const) {
      const state = readingFormFallback(mode, "no_reply", soloForm());
      assert.equal(state.errors?.form, SUBMIT_FAILED_MESSAGE);
      assert.equal(state.values?.bodyText, BODY);
    }
  });

  it("a deploy since the page loaded: APP_UPDATED_MESSAGE, values kept", () => {
    for (const mode of ["solo", "create", "edit", "title"] as const) {
      const state = readingFormFallback(mode, "app_updated", soloForm());
      assert.equal(state.errors?.form, APP_UPDATED_MESSAGE);
      assert.equal(state.values?.bodyText, BODY);
    }
  });

  it("the copy: curly apostrophes, no em dash", () => {
    for (const text of [CREATE_NO_REPLY_MESSAGE, APP_UPDATED_MESSAGE, SUBMIT_FAILED_MESSAGE]) {
      assert.doesNotMatch(text, /'|—/);
    }
  });
});

describe("questionPanelFallback", () => {
  it("puts the error on the panel (publish) or its card, never a rejection", () => {
    const publish = new FormData();
    publish.set("intent", "publish");
    assert.deepEqual(questionPanelFallback("no_reply", publish), { intent: "publish", questionId: undefined, error: SUBMIT_FAILED_MESSAGE });
    assert.deepEqual(questionPanelFallback("app_updated", publish), { intent: "publish", questionId: undefined, error: APP_UPDATED_MESSAGE });
    const update = new FormData();
    update.set("intent", "update");
    update.set("questionId", "q1");
    assert.deepEqual(questionPanelFallback("no_reply", update), { intent: "update", questionId: "q1", error: SUBMIT_FAILED_MESSAGE });
  });
});
