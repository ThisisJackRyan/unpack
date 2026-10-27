import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { PRIVACY_RULE, QUESTIONS_TOOL_NAME } from "./prompts";
import {
  buildQuestionRequest,
  parseQuestionsResponse,
  QUESTION_ERROR_MESSAGES,
  questionErrorKind,
  questionErrorLogFields,
  QuestionWriterError,
  writeQuestionSet,
  writeReplacementQuestion,
  type QuestionModel,
} from "./questions";
import { QUESTION_WRITE_DEADLINE_MS } from "./settings";

const BODY = "Mia found a fox in the snow. ".repeat(20);

function toolUse(input: unknown, name = QUESTIONS_TOOL_NAME) {
  return { type: "tool_use", id: "toolu_1", name, input };
}

function message(content: unknown[], stop_reason = "tool_use") {
  return { content, stop_reason } as unknown as Anthropic.Message;
}

function fakeModel(responses: (Anthropic.Message | Error)[]) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const model: QuestionModel = {
    model: "claude-sonnet-5-5",
    create: async (params) => {
      calls.push(params);
      const next = responses.shift();
      if (!next) throw new Error("no more responses");
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { model, calls };
}

const THREE = ["Why did Mia go out?", "What did the fox do?", "What do you think Mia should do next?"];

describe("parseQuestionsResponse", () => {
  it("accepts exactly the right count, trimmed", () => {
    const r = parseQuestionsResponse(message([toolUse({ questions: ["  A? ", "B?", "C?"] })]), 3);
    assert.deepEqual(r, { ok: true, questions: ["A?", "B?", "C?"] });
  });

  it("finds the tool call after thinking and text blocks", () => {
    const r = parseQuestionsResponse(
      message([
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "redacted_thinking", data: "x" },
        { type: "text", text: "Here you go." },
        toolUse({ questions: THREE }),
      ]),
      3,
    );
    assert.deepEqual(r, { ok: true, questions: THREE });
  });

  it("ignores a tool call with another name", () => {
    const r = parseQuestionsResponse(message([toolUse({ questions: THREE }, "other_tool")]), 3);
    assert.equal(r.ok, false);
  });

  it("rejects a missing tool block", () => {
    const r = parseQuestionsResponse(message([{ type: "text", text: "1. Why?" }], "end_turn"), 3);
    assert.deepEqual(r, { ok: false, problem: `no ${QUESTIONS_TOOL_NAME} tool call` });
  });

  it("says when output was cut off", () => {
    const r = parseQuestionsResponse(message([{ type: "thinking", thinking: "" }], "max_tokens"), 3);
    assert.equal(r.ok, false);
    assert.match((r as { problem: string }).problem, /cut off/);
  });

  it("rejects a refusal even with a tool block", () => {
    const r = parseQuestionsResponse(message([toolUse({ questions: THREE })], "refusal"), 3);
    assert.equal(r.ok, false);
  });

  it("rejects the wrong count", () => {
    const r = parseQuestionsResponse(message([toolUse({ questions: THREE.slice(0, 2) })]), 3);
    assert.deepEqual(r, { ok: false, problem: "expected exactly 3 questions" });
  });

  it("rejects an empty or blank question", () => {
    const r = parseQuestionsResponse(message([toolUse({ questions: ["A?", "   ", "C?"] })]), 3);
    assert.deepEqual(r, { ok: false, problem: "a question was empty" });
  });

  it("rejects a question over 300 characters", () => {
    const r = parseQuestionsResponse(message([toolUse({ questions: ["A?", "x".repeat(301), "C?"] })]), 3);
    assert.deepEqual(r, { ok: false, problem: "a question was over 300 characters" });
    const ok = parseQuestionsResponse(message([toolUse({ questions: ["A?", "x".repeat(300), "C?"] })]), 3);
    assert.equal(ok.ok, true);
  });

  it("rejects duplicates, ignoring case, spacing, and punctuation", () => {
    const r = parseQuestionsResponse(
      message([toolUse({ questions: ["Why did Mia go?", "why  did mia go ?", "C?"] })]),
      3,
    );
    assert.deepEqual(r, { ok: false, problem: "two questions were the same" });
  });

  it("rejects a question that repeats one to avoid", () => {
    const r = parseQuestionsResponse(message([toolUse({ questions: ["What did the fox do?"] })]), 1, THREE);
    assert.equal(r.ok, false);
  });

  it("rejects the wrong input shape", () => {
    for (const input of [{}, { questions: "A?" }, { questions: [1, 2, 3] }, null]) {
      assert.equal(parseQuestionsResponse(message([toolUse(input)]), 3).ok, false);
    }
  });
});

describe("buildQuestionRequest", () => {
  const req = buildQuestionRequest("claude-sonnet-5-5", "prompt");

  it("uses the tool with auto tool choice and strict input", () => {
    assert.deepEqual(req.tool_choice, { type: "auto", disable_parallel_tool_use: true });
    assert.equal(req.tools?.length, 1);
    const tool = req.tools![0] as Anthropic.Tool;
    assert.equal(tool.name, QUESTIONS_TOOL_NAME);
    assert.equal(tool.strict, true);
    assert.equal(tool.input_schema.additionalProperties, false);
  });

  it("sends no sampling params, thinking config, or prefill", () => {
    const body = req as unknown as Record<string, unknown>;
    for (const key of ["temperature", "top_p", "top_k", "thinking"]) {
      assert.equal(key in body, false, key);
    }
    assert.equal(req.messages.length, 1);
    assert.equal(req.messages[0].role, "user");
    assert.equal(req.model, "claude-sonnet-5-5");
  });
});

describe("writeQuestionSet", () => {
  const input = { bodyText: BODY, gradeLevel: "4" as const, count: 3 };

  it("returns valid output from one call", async () => {
    const { model, calls } = fakeModel([message([toolUse({ questions: THREE })])]);
    assert.deepEqual(await writeQuestionSet(model, input), THREE);
    assert.equal(calls.length, 1);
  });

  it("retries once on invalid output, telling the model what was wrong", async () => {
    const { model, calls } = fakeModel([
      message([toolUse({ questions: THREE.slice(0, 2) })]),
      message([toolUse({ questions: THREE })]),
    ]);
    assert.deepEqual(await writeQuestionSet(model, input), THREE);
    assert.equal(calls.length, 2);
    const second = calls[1].messages[0].content as string;
    assert.match(second, /rejected: expected exactly 3 questions/);
    assert.equal(calls[1].messages.length, 1);
  });

  it("gives up after the one retry with a failed error", async () => {
    const { model, calls } = fakeModel([
      message([{ type: "text", text: "no" }], "end_turn"),
      message([toolUse({ questions: [] })]),
      message([toolUse({ questions: THREE })]),
    ]);
    await assert.rejects(writeQuestionSet(model, input), (error: unknown) => {
      assert.ok(error instanceof QuestionWriterError);
      assert.equal(error.kind, "failed");
      return true;
    });
    assert.equal(calls.length, 2);
  });

  it("does not retry API errors itself (the SDK already did)", async () => {
    const { model, calls } = fakeModel([
      new Anthropic.RateLimitError(429, {}, "slow", new Headers()),
      message([toolUse({ questions: THREE })]),
    ]);
    await assert.rejects(writeQuestionSet(model, input), Anthropic.RateLimitError);
    assert.equal(calls.length, 1);
  });
});

describe("writeReplacementQuestion", () => {
  it("asks for 1 question that differs from the current ones", async () => {
    const { model, calls } = fakeModel([
      message([toolUse({ questions: ["What did the fox do?"] })]),
      message([toolUse({ questions: ["Where did Mia find the fox?"] })]),
    ]);
    const q = await writeReplacementQuestion(model, {
      bodyText: BODY,
      gradeLevel: "4",
      position: 1,
      count: 3,
      current: THREE,
    });
    assert.equal(q, "Where did Mia find the fox?");
    assert.equal(calls.length, 2);
    const prompt = calls[0].messages[0].content as string;
    assert.match(prompt, /replace question 1 of 3/);
    assert.match(prompt, /detail question/);
    assert.match(prompt, /What did the fox do\?/);
  });

  it("keeps the own-take role for the last position", async () => {
    const { model, calls } = fakeModel([message([toolUse({ questions: ["What would you do?"] })])]);
    await writeReplacementQuestion(model, {
      bodyText: BODY,
      gradeLevel: "4",
      position: 3,
      count: 3,
      current: THREE,
    });
    assert.match(calls[0].messages[0].content as string, /"what do you think" question/);
  });
});

describe("privacy rule in requests", () => {
  it("is in the system prompt of full-set and replacement requests", async () => {
    const { model, calls } = fakeModel([
      message([toolUse({ questions: THREE })]),
      message([toolUse({ questions: ["What would you change in the story?"] })]),
    ]);
    await writeQuestionSet(model, { bodyText: BODY, gradeLevel: "4", count: 3 });
    await writeReplacementQuestion(model, {
      bodyText: BODY,
      gradeLevel: "4",
      position: 3,
      count: 3,
      current: THREE,
    });
    assert.equal(calls.length, 2);
    for (const call of calls) assert.ok(String(call.system).includes(PRIVACY_RULE));
  });
});

// A model call that never answers: it only settles when its signal aborts,
// the way the SDK does (APIUserAbortError).
function hangingModel(options: { honorSignal?: boolean } = {}) {
  let calls = 0;
  const model: QuestionModel = {
    model: "claude-sonnet-5-5",
    create: (_params, { signal }) => {
      calls++;
      return new Promise((_, reject) => {
        if (options.honorSignal === false) return;
        signal.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError()), { once: true });
      });
    },
  };
  return { model, calls: () => calls };
}

describe("write deadline", () => {
  const input = { bodyText: BODY, gradeLevel: "4" as const, count: 3 };

  // AbortSignal.timeout's timer doesn't hold the event loop open (in the
  // app, the open request does), so a test with only a hanging call would
  // end before the deadline fires.
  let keepAlive: ReturnType<typeof setInterval>;
  beforeEach(() => {
    keepAlive = setInterval(() => {}, 1_000);
  });
  afterEach(() => clearInterval(keepAlive));

  it("is 110 seconds by default", () => {
    assert.equal(QUESTION_WRITE_DEADLINE_MS, 110_000);
  });

  it("passes the deadline signal to every call", async () => {
    const { model, calls } = fakeModel([message([toolUse({ questions: THREE })])]);
    const seen: (AbortSignal | undefined)[] = [];
    const create = model.create;
    model.create = (params, options) => {
      seen.push(options?.signal);
      return create(params, options);
    };
    await writeQuestionSet(model, input);
    assert.equal(calls.length, 1);
    assert.ok(seen[0] instanceof AbortSignal);
    assert.equal(seen[0]!.aborted, false);
  });

  it("aborts a hanging call and maps it to the timeout message", async () => {
    const { model, calls } = hangingModel();
    const started = Date.now();
    await assert.rejects(writeQuestionSet(model, input, { deadlineMs: 30 }), (error: unknown) => {
      // The SDK's APIUserAbortError or the deadline's TimeoutError,
      // whichever settles first; both are a timeout.
      assert.equal(questionErrorKind(error), "timeout");
      assert.equal(QUESTION_ERROR_MESSAGES[questionErrorKind(error)], "That took too long. Try again.");
      return true;
    });
    assert.ok(Date.now() - started < 1_000);
    assert.equal(calls(), 1);
  });

  it("ends the write even if a call ignores its signal", async () => {
    const { model } = hangingModel({ honorSignal: false });
    await assert.rejects(
      writeReplacementQuestion(
        model,
        { bodyText: BODY, gradeLevel: "4", position: 1, count: 3, current: THREE },
        { deadlineMs: 30 },
      ),
      (error: unknown) => questionErrorKind(error) === "timeout",
    );
  });

  it("covers both attempts: no second attempt starts after the deadline", async () => {
    const calls: number[] = [];
    const model: QuestionModel = {
      model: "claude-sonnet-5-5",
      create: async () => {
        calls.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 40));
        return message([toolUse({ questions: ["Only one?"] })]);
      },
    };
    await assert.rejects(writeQuestionSet(model, input, { deadlineMs: 25 }), (error: unknown) => {
      assert.equal(questionErrorKind(error), "timeout");
      return true;
    });
    // Give a would-be second attempt time to start.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(calls.length, 1);
  });

  it("maps every abort shape to timeout", () => {
    assert.equal(questionErrorKind(new Anthropic.APIUserAbortError()), "timeout");
    assert.equal(questionErrorKind(new DOMException("deadline", "TimeoutError")), "timeout");
    assert.equal(questionErrorKind(new DOMException("aborted", "AbortError")), "timeout");
    const signal = AbortSignal.abort(new DOMException("deadline", "TimeoutError"));
    assert.equal(questionErrorKind(signal.reason), "timeout");
  });
});

describe("questionErrorKind", () => {
  const headers = new Headers({ "request-id": "req_123" });

  it("maps timeouts", () => {
    assert.equal(questionErrorKind(new Anthropic.APIConnectionTimeoutError()), "timeout");
  });

  it("maps connection errors to failed", () => {
    assert.equal(questionErrorKind(new Anthropic.APIConnectionError({ message: "x" })), "failed");
  });

  it("maps 429 and 529 to busy", () => {
    assert.equal(questionErrorKind(new Anthropic.RateLimitError(429, {}, "x", headers)), "busy");
    const overloaded = Anthropic.APIError.generate(
      529,
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      undefined,
      headers,
    );
    assert.equal(questionErrorKind(overloaded), "busy");
  });

  it("maps 401, 403, and 404 to not configured", () => {
    for (const status of [401, 403, 404]) {
      const error = Anthropic.APIError.generate(status, {}, "x", headers);
      assert.equal(questionErrorKind(error), "not_configured", String(status));
    }
  });

  it("maps 500 and 400 to failed", () => {
    for (const status of [500, 400]) {
      assert.equal(questionErrorKind(Anthropic.APIError.generate(status, {}, "x", headers)), "failed");
    }
  });

  it("maps a missing key and unknown errors", () => {
    assert.equal(questionErrorKind(new QuestionWriterError("not_configured", "no key")), "not_configured");
    assert.equal(questionErrorKind(new Error("boom")), "failed");
    assert.equal(questionErrorKind("boom"), "failed");
  });

  it("has a short, plain message for every kind", () => {
    assert.deepEqual(QUESTION_ERROR_MESSAGES, {
      not_configured: "Question writing isn’t set up yet.",
      busy: "Question writing is busy right now. Try again in a minute.",
      timeout: "That took too long. Try again.",
      failed: "We couldn’t write questions this time. Try again.",
    });
    for (const m of Object.values(QUESTION_ERROR_MESSAGES)) {
      assert.equal(m.includes("—"), false);
      assert.equal(m.includes("'"), false);
    }
  });

  it("logs only safe fields", () => {
    const error = new Anthropic.RateLimitError(429, {}, `secret ${BODY}`, headers);
    const fields = questionErrorLogFields(error);
    assert.deepEqual(Object.keys(fields).sort(), ["kind", "name", "requestId", "status", "type"]);
    assert.equal(fields.requestId, "req_123");
    assert.equal(JSON.stringify(fields).includes("Mia"), false);
  });
});
