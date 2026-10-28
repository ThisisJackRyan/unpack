import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { questionPanelFallback } from "@/app/teacher/classes/[id]/readings/[readingId]/question-state";
import { SUBMIT_FAILED_MESSAGE } from "@/lib/answer-check-guard";
import { withRejectionFallback } from "./action-fallback";
import { APP_UPDATED_MESSAGE } from "./answer-form-state";
import { CHECK_READINGS_LINK_TEXT, noReplyParts, readingFormFallback, readingsListHref } from "./reading-form-fallback";
import { CREATE_NO_REPLY_MESSAGE, type ReadingFormState } from "./reading-form-state";

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

  it("logs the kind and the error's name only, never its message", async () => {
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      for (const error of [new TypeError("FAKE pasted text"), unrecognized()]) {
        await withRejectionFallback(async () => Promise.reject(error), () => "fallback", rethrowNext)("prev", new FormData());
      }
    } finally {
      console.error = original;
    }
    assert.deepEqual(logged, [
      ["form action rejected", { kind: "no_reply", name: "TypeError" }],
      ["form action rejected", { kind: "app_updated", name: "UnrecognizedActionError" }],
    ]);
  });

  it("lets Next's redirect and not-found through", async () => {
    for (const digest of ["NEXT_REDIRECT;replace;/learn/r/1;303;", "NEXT_HTTP_ERROR_FALLBACK;404"]) {
      const action = withRejectionFallback(async () => Promise.reject(Object.assign(new Error("next"), { digest })), () => "fallback", rethrowNext);
      await assert.rejects(action("prev", new FormData()), (e: unknown) => (e as { digest?: string }).digest === digest);
    }
  });
});

describe("readingFormFallback", () => {
  it("a create with no reply: the no-reply message, every value back in the fields", async () => {
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
      assert.doesNotMatch(text, /'|\u2014/);
    }
  });
});

describe("noReplyParts", () => {
  it("the approved wording, word for word", () => {
    assert.equal(
      CREATE_NO_REPLY_MESSAGE,
      "We couldn\u2019t hear back. Your reading may have saved anyway. What you typed is still here. Check your readings before you try again.",
    );
  });

  it("links \"Check your readings\" to the list for each create form, the sentence unchanged", () => {
    for (const [mode, classId, href] of [
      ["solo", undefined, "/learn"],
      ["create", "c1", "/teacher/classes/c1"],
    ] as const) {
      assert.equal(readingsListHref(mode, classId), href);
      const parts = noReplyParts(CREATE_NO_REPLY_MESSAGE, readingsListHref(mode, classId));
      assert.ok(parts, mode);
      assert.equal(parts.href, href);
      assert.equal(parts.linkText, CHECK_READINGS_LINK_TEXT);
      assert.equal(parts.before + parts.linkText + parts.after, CREATE_NO_REPLY_MESSAGE);
      assert.equal(parts.after, " before you try again.");
    }
  });

  it("no link for other messages, an edit, or a teacher form without its class", () => {
    assert.equal(noReplyParts(SUBMIT_FAILED_MESSAGE, "/learn"), null);
    assert.equal(noReplyParts(undefined, "/learn"), null);
    assert.equal(readingsListHref("edit", "c1"), null);
    assert.equal(readingsListHref("title", "c1"), null);
    assert.equal(readingsListHref("create"), null);
    assert.equal(noReplyParts(CREATE_NO_REPLY_MESSAGE, null), null);
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
