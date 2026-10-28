import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { GatewayRateLimitError, GatewayResponseError } from "@ai-sdk/gateway";
import { APICallError } from "ai";
import type { ModelReply, ModelRequest } from "./model";
import { PRIVACY_RULE, QUESTIONS_TOOL_NAME } from "./prompts";
import {
  buildQuestionRequest,
  parseQuestionsResponse,
  QUESTION_ERROR_MESSAGES,
  questionErrorKind,
  questionErrorLogFields,
  QUESTIONS_TOOL,
  QuestionWriterError,
  writeQuestionSet,
  writeReplacementQuestion,
  type QuestionModel,
  type WriteReport,
} from "./questions";
import { QUESTION_EFFORT, QUESTION_MAX_TOKENS, QUESTION_WRITE_DEADLINE_MS } from "./settings";
import { gatewayErrors, retried } from "./test-fixtures";
import { questionsGenerateReporter } from "../timing-log";

const BODY = "Mia found a fox in the snow. ".repeat(20);

type Call = ModelReply["toolCalls"][number];

function toolUse(input: unknown, name = QUESTIONS_TOOL_NAME): Call {
  return { toolName: name, input };
}

// finishReason is the AI SDK's; raw is Anthropic's stop_reason.
function message(toolCalls: Call[], finishReason = "tool-calls", rawFinishReason?: string): ModelReply {
  return { finishReason, rawFinishReason, toolCalls };
}

function fakeModel(responses: (ModelReply | Error)[]) {
  const calls: ModelRequest[] = [];
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

  it("finds the tool call by name, not position", () => {
    const r = parseQuestionsResponse(
      message([toolUse({ questions: ["x"] }, "other_tool"), toolUse({ questions: THREE })]),
      3,
    );
    assert.deepEqual(r, { ok: true, questions: THREE });
  });

  it("rejects a call the SDK couldn't parse", () => {
    const r = parseQuestionsResponse(
      message([{ toolName: QUESTIONS_TOOL_NAME, input: '{"questions": ["A?"', invalid: true }]),
      3,
    );
    assert.equal(r.ok, false);
  });

  it("ignores a tool call with another name", () => {
    const r = parseQuestionsResponse(message([toolUse({ questions: THREE }, "other_tool")]), 3);
    assert.equal(r.ok, false);
  });

  it("rejects a missing tool block", () => {
    const r = parseQuestionsResponse(message([], "stop", "end_turn"), 3);
    assert.deepEqual(r, { ok: false, problem: `no ${QUESTIONS_TOOL_NAME} tool call` });
  });

  it("says when output was cut off", () => {
    for (const reply of [message([], "length", "max_tokens"), message([], "length"), message([], "other", "max_tokens")]) {
      const r = parseQuestionsResponse(reply, 3);
      assert.equal(r.ok, false);
      assert.match((r as { problem: string }).problem, /cut off/);
    }
  });

  it("rejects a refusal even with a tool block", () => {
    for (const reply of [
      message([toolUse({ questions: THREE })], "content-filter", "refusal"),
      message([toolUse({ questions: THREE })], "content-filter"),
      message([toolUse({ questions: THREE })], "other", "refusal"),
    ]) {
      assert.deepEqual(parseQuestionsResponse(reply, 3), { ok: false, problem: "the model declined" });
    }
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
  const req = buildQuestionRequest("anthropic/claude-sonnet-5.5", "prompt");

  it("uses the one strict tool, with the same name, description, and schema", () => {
    assert.equal(req.tool, QUESTIONS_TOOL);
    assert.equal(req.tool.name, QUESTIONS_TOOL_NAME);
    assert.equal(req.tool.strict, true);
    assert.equal(req.tool.inputSchema.additionalProperties, false);
    assert.deepEqual(req.tool.inputSchema.required, ["questions"]);
    assert.equal(
      req.tool.description,
      "Submit the finished questions, in order. Call this exactly once with every question.",
    );
  });

  it("keeps the output limit and low effort", () => {
    assert.equal(req.maxOutputTokens, QUESTION_MAX_TOKENS);
    assert.equal(req.maxOutputTokens, 8_000);
    assert.equal(req.effort, QUESTION_EFFORT);
    assert.equal(req.effort, "low");
  });

  it("sends no sampling params, thinking config, or prefill", () => {
    const body = req as unknown as Record<string, unknown>;
    for (const key of ["temperature", "top_p", "top_k", "topP", "topK", "thinking"]) {
      assert.equal(key in body, false, key);
    }
    assert.equal(req.messages.length, 1);
    assert.equal(req.messages[0].role, "user");
    assert.equal(req.messages[0].content, "prompt");
    assert.equal(req.model, "anthropic/claude-sonnet-5.5");
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
      message([], "stop", "end_turn"),
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

  it("does not retry gateway errors itself (the SDK already did)", async () => {
    const { model, calls } = fakeModel([
      gatewayErrors.rateLimited(),
      message([toolUse({ questions: THREE })]),
    ]);
    await assert.rejects(writeQuestionSet(model, input), (e: unknown) => GatewayRateLimitError.isInstance(e));
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
// the way the gateway provider does (fetch's abort, wrapped in a
// GatewayResponseError).
function hangingModel(options: { honorSignal?: boolean } = {}) {
  let calls = 0;
  const model: QuestionModel = {
    model: "claude-sonnet-5-5",
    create: (_params, { signal }) => {
      calls++;
      return new Promise((_, reject) => {
        if (options.honorSignal === false) return;
        signal.addEventListener(
          "abort",
          () => reject(new GatewayResponseError({ statusCode: 500, cause: signal.reason })),
          { once: true },
        );
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
      // The gateway's wrapped abort or the deadline's TimeoutError,
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
    assert.equal(questionErrorKind(new GatewayResponseError({ cause: new DOMException("aborted", "AbortError") })), "timeout");
    assert.equal(questionErrorKind(gatewayErrors.requestTimeout()), "timeout");
    assert.equal(questionErrorKind(retried(gatewayErrors.requestTimeout())), "timeout");
    assert.equal(questionErrorKind(new DOMException("deadline", "TimeoutError")), "timeout");
    assert.equal(questionErrorKind(new DOMException("aborted", "AbortError")), "timeout");
    const signal = AbortSignal.abort(new DOMException("deadline", "TimeoutError"));
    assert.equal(questionErrorKind(signal.reason), "timeout");
  });
});

describe("questionErrorKind", () => {
  // Every failure the gateway or the SDK reports, and what the user sees.
  const table: [string, unknown, string][] = [
    ["no credentials (401)", gatewayErrors.noCredentials(), "not_configured"],
    ["bad key (401)", gatewayErrors.badKey(), "not_configured"],
    ["401 as rethrown by generateText (dev)", gatewayErrors.wrappedAuthDev(), "not_configured"],
    ["401 as rethrown by generateText (production)", gatewayErrors.wrappedAuthProduction(), "not_configured"],
    ["out of credits (402)", gatewayErrors.outOfCredits(), "not_configured"],
    ["no permission (403)", gatewayErrors.forbidden(), "not_configured"],
    ["unknown model (404)", gatewayErrors.unknownModel(), "not_configured"],
    ["rate limited (429)", gatewayErrors.rateLimited(), "busy"],
    ["overloaded (529)", gatewayErrors.overloaded(), "busy"],
    ["server error (500)", gatewayErrors.serverError(), "failed"],
    ["unavailable (503)", gatewayErrors.unavailable(), "failed"],
    ["bad request (400)", gatewayErrors.badRequest(), "failed"],
    ["network error", gatewayErrors.network(), "failed"],
    ["per-request timeout", gatewayErrors.requestTimeout(), "timeout"],
    ["write deadline", new DOMException("deadline", "TimeoutError"), "timeout"],
  ];

  for (const [name, error, kind] of table) {
    it(`maps ${name} to ${kind}, alone or after the SDK's retries`, () => {
      assert.equal(questionErrorKind(error), kind);
      assert.equal(questionErrorKind(retried(error)), kind);
    });
  }

  it("maps a bare APICallError by status, and an overloaded body to busy", () => {
    const api = (statusCode: number, data?: unknown) =>
      new APICallError({ message: "x", url: "https://example.test", requestBodyValues: {}, statusCode, data });
    assert.equal(questionErrorKind(api(401)), "not_configured");
    assert.equal(questionErrorKind(api(402)), "not_configured");
    assert.equal(questionErrorKind(api(403)), "not_configured");
    assert.equal(questionErrorKind(api(404)), "not_configured");
    assert.equal(questionErrorKind(api(429)), "busy");
    assert.equal(questionErrorKind(api(529)), "busy");
    assert.equal(questionErrorKind(api(500, { error: { type: "overloaded_error" } })), "busy");
    assert.equal(questionErrorKind(api(500)), "failed");
    assert.equal(questionErrorKind(api(400)), "failed");
  });

  it("maps a missing key and unknown errors", () => {
    assert.equal(questionErrorKind(new QuestionWriterError("not_configured", "no credentials")), "not_configured");
    assert.equal(questionErrorKind(new Error("boom")), "failed");
    assert.equal(questionErrorKind("boom"), "failed");
  });

  it("has a short, plain message for every kind", () => {
    assert.deepEqual(QUESTION_ERROR_MESSAGES, {
      not_configured: "Question writing isn’t available right now. Trying again soon won’t help, so please check back later.",
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
    const error = new GatewayRateLimitError({ message: `secret ${BODY}`, statusCode: 429, generationId: "gen_123" });
    const fields = questionErrorLogFields(error);
    assert.deepEqual(Object.keys(fields).sort(), ["causes", "generationId", "kind", "name", "status", "timedOut", "type"]);
    assert.equal(fields.generationId, "gen_123");
    assert.equal(fields.status, 429);
    assert.equal(fields.type, "rate_limit_exceeded");
    assert.equal(JSON.stringify(fields).includes("Mia"), false);
  });

  it("logs the last try's status and safe error fields after retries, nothing else", () => {
    const fields = questionErrorLogFields(retried(gatewayErrors.requestTimeout()));
    assert.deepEqual(fields, {
      kind: "timeout",
      name: "AI_RetryError",
      causes: [],
      timedOut: false,
      tries: 2,
      retryReason: "maxRetriesExceeded",
      last: { name: "GatewayResponseError", causes: [{ name: "TimeoutError", code: 23 }], timedOut: true },
      status: 500,
      type: "response_error",
    });
  });

  it("never logs a message, even one quoting the request", () => {
    const cause = Object.assign(new Error(`upstream said ${BODY}`), { code: "provider_error_mia" });
    const error = new GatewayRateLimitError({ message: `secret ${BODY}`, statusCode: 429, cause });
    const json = JSON.stringify(questionErrorLogFields(error));
    assert.equal(json.includes(BODY), false);
    assert.equal(json.includes("secret"), false);
    assert.equal(json.includes("provider_error_mia"), false);
  });
});

describe("write report (the questions.generate log)", () => {
  const input = { bodyText: BODY, gradeLevel: "4" as const, count: 3 };

  // A fake clock: each read moves 250ms on.
  function steppingClock() {
    let t = 1_000;
    return () => (t += 250);
  }

  function collect() {
    const reports: WriteReport[] = [];
    return { reports, options: { onReport: (r: WriteReport) => reports.push(r), now: steppingClock() } };
  }

  it("ok on the first attempt: one report, one attempt, the clock's duration", async () => {
    const { model } = fakeModel([message([toolUse({ questions: THREE })])]);
    const { reports, options } = collect();
    await writeQuestionSet(model, input, options);
    assert.deepEqual(reports, [{ outcome: "ok", durationMs: 250, attempts: 1, httpRequests: 0 }]);
  });

  it("ok after invalid output: two attempts", async () => {
    const { model } = fakeModel([message([]), message([toolUse({ questions: THREE })])]);
    const { reports, options } = collect();
    await writeQuestionSet(model, input, options);
    assert.deepEqual(reports, [{ outcome: "ok", durationMs: 250, attempts: 2, httpRequests: 0 }]);
  });

  it("invalid output twice: invalid, two attempts, and the write still throws", async () => {
    const { model } = fakeModel([message([]), message([toolUse({ questions: ["One?"] })])]);
    const { reports, options } = collect();
    await assert.rejects(writeQuestionSet(model, input, options), QuestionWriterError);
    assert.deepEqual(reports, [{ outcome: "invalid", durationMs: 250, attempts: 2, httpRequests: 0 }]);
  });

  it("a gateway error: its kind, one attempt", async () => {
    const { model } = fakeModel([retried(gatewayErrors.rateLimited())]);
    const { reports, options } = collect();
    await assert.rejects(writeReplacementQuestion(model, { ...input, position: 1, current: THREE }, options));
    assert.equal(reports.length, 1);
    assert.equal(reports[0].outcome, "busy");
    assert.equal(reports[0].attempts, 1);
  });

  it("counts the HTTP requests a model reports", async () => {
    const model: QuestionModel = {
      model: "claude-sonnet-5-5",
      create: async (_params, { onRequest }) => {
        onRequest?.();
        onRequest?.();
        return message([toolUse({ questions: THREE })]);
      },
    };
    const { reports, options } = collect();
    await writeQuestionSet(model, input, options);
    assert.equal(reports[0].httpRequests, 2);
  });

  it("a throwing reporter doesn't fail a good write or report it twice", async () => {
    const { model } = fakeModel([message([toolUse({ questions: THREE })])]);
    const outcomes: string[] = [];
    const onReport = (r: WriteReport) => {
      outcomes.push(r.outcome);
      throw new Error("reporter broke");
    };
    assert.deepEqual(await writeQuestionSet(model, input, { onReport }), THREE);
    assert.deepEqual(outcomes, ["ok"]);
  });

  it("a throwing reporter doesn't replace the write's own error", async () => {
    const { model } = fakeModel([retried(gatewayErrors.rateLimited())]);
    const outcomes: string[] = [];
    const onReport = (r: WriteReport) => {
      outcomes.push(r.outcome);
      throw new Error("reporter broke");
    };
    await assert.rejects(writeQuestionSet(model, input, { onReport }), (error) => questionErrorKind(error) === "busy");
    assert.deepEqual(outcomes, ["busy"]);
  });

  it("the real reporter's line never carries an error's text, only the allowed keys", async () => {
    const { model } = fakeModel([new Error(`upstream echoed the request: ${BODY}`)]);
    const lines: string[] = [];
    const onReport = questionsGenerateReporter(
      { readingId: "6f1c2a52-3c0e-4b8e-9b7a-2f0d1e4c5a6b", mode: "per_student" },
      (line) => lines.push(line),
    );
    await assert.rejects(writeQuestionSet(model, input, { onReport, now: steppingClock() }));
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes("Mia found a fox"));
    assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), [
      "attempts",
      "durationMs",
      "event",
      "mode",
      "outcome",
      "readingId",
    ]);
  });

  describe("timeout", () => {
    let keepAlive: ReturnType<typeof setInterval>;
    beforeEach(() => {
      keepAlive = setInterval(() => {}, 1_000);
    });
    afterEach(() => clearInterval(keepAlive));

    it("the deadline: timeout, reported once", async () => {
      const { model } = hangingModel();
      const reports: WriteReport[] = [];
      await assert.rejects(writeQuestionSet(model, input, { deadlineMs: 20, onReport: (r) => reports.push(r) }));
      assert.equal(reports.length, 1);
      assert.equal(reports[0].outcome, "timeout");
      assert.equal(reports[0].attempts, 1);
      assert.ok(reports[0].durationMs >= 15);
    });
  });
});
