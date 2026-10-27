// The real adapter, driven through a fake fetch: the exact request the
// gateway provider sends, and how each HTTP failure maps to what the user
// sees. No network: every request goes to the fake.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { checkEffort, EFFORT_TOOL } from "./effort-check";
import { EFFORT_SYSTEM_PROMPT, effortCheckPrompt } from "./effort-prompts";
import { createGatewayCall, GATEWAY_ROUTING, withRequestTimeout } from "./gateway-adapter";
import type { QuestionModel } from "./model";
import { QUESTIONS_SYSTEM_PROMPT, QUESTIONS_TOOL_NAME, questionSetPrompt, SOLO_QUESTIONS_SYSTEM_PROMPT } from "./prompts";
import { QUESTIONS_TOOL, questionErrorKind, writeQuestionSet } from "./questions";
import { AI_MAX_RETRIES, AI_TIMEOUT_MS } from "./settings";

const MODEL = "anthropic/claude-sonnet-5.5";
const KEY = "test-gateway-key";
const BODY = "A fox ran into the snow. ".repeat(10);
const THREE = ["Why did the fox run?", "Where did it go?", "What would you do?"];

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown>; signal?: AbortSignal };
type Respond = (sent: Sent) => Promise<Response> | Response;

// A gateway reply: the LanguageModelV4 result the gateway returns.
function generated(toolName: string, input: unknown, raw = "tool_use"): Response {
  return Response.json({
    content: [
      { type: "text", text: "Here you go." },
      { type: "tool-call", toolCallId: "call_1", toolName, input: JSON.stringify(input) },
    ],
    finishReason: { unified: raw === "tool_use" ? "tool-calls" : "stop", raw },
    usage: { inputTokens: { total: 10 }, outputTokens: { total: 10 } },
    warnings: [],
  });
}

// A gateway error body, with a retry-after so retried tries don't wait.
function gatewayError(status: number, type: string): Response {
  return Response.json(
    { error: { message: "nope", type }, generationId: "gen_test" },
    { status, headers: { "retry-after-ms": "1" } },
  );
}

function fakeFetch(respond: Respond) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const entry: Sent = {
      url: String(input),
      headers,
      body: JSON.parse(String(init?.body)),
      signal: init?.signal ?? undefined,
    };
    sent.push(entry);
    return respond(entry);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

function adapter(respond: Respond, options: { apiKey?: string; timeoutMs?: number; maxRetries?: number } = {}) {
  const { fetch, sent } = fakeFetch(respond);
  const create = createGatewayCall({
    apiKey: "apiKey" in options ? options.apiKey : KEY,
    timeoutMs: options.timeoutMs ?? AI_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? AI_MAX_RETRIES,
    fetch,
  });
  const model: QuestionModel = { model: MODEL, create };
  return { model, sent };
}

// A fetch that never answers until its signal aborts, like a stuck request.
const hang: Respond = (sent) =>
  new Promise((_, reject) => {
    sent.signal?.addEventListener("abort", () => reject(sent.signal!.reason), { once: true });
  });

// AbortSignal.timeout's timer doesn't hold the event loop open (see the
// write deadline tests in questions.test.ts).
let keepAlive: ReturnType<typeof setInterval>;
beforeEach(() => {
  keepAlive = setInterval(() => {}, 1_000);
});
afterEach(() => clearInterval(keepAlive));

describe("gateway request", () => {
  it("sends the question request as before: model, strict tool, auto choice, limits, effort, prompts", async () => {
    const { model, sent } = adapter(() => generated(QUESTIONS_TOOL_NAME, { questions: THREE }));
    const input = { bodyText: BODY, gradeLevel: "4" as const, count: 3 };
    assert.deepEqual(await writeQuestionSet(model, input), THREE);
    assert.equal(sent.length, 1);
    const [{ url, headers, body }] = sent;
    assert.equal(url, "https://ai-gateway.vercel.sh/v4/ai/language-model");
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    assert.equal(headers["ai-gateway-auth-method"], "api-key");
    assert.equal(headers["ai-language-model-id"], MODEL);
    assert.equal(headers["ai-language-model-streaming"], "false");
    assert.equal(body.maxOutputTokens, 8_000);
    assert.deepEqual(body.toolChoice, { type: "auto" });
    assert.deepEqual(body.tools, [
      {
        type: "function",
        name: QUESTIONS_TOOL.name,
        description: QUESTIONS_TOOL.description,
        inputSchema: QUESTIONS_TOOL.inputSchema,
        strict: true,
      },
    ]);
    // Byte-identical prompts: the system prompt as the system message, the
    // per-request prompt as the one user message.
    assert.deepEqual(body.prompt, [
      { role: "system", content: QUESTIONS_SYSTEM_PROMPT },
      { role: "user", content: [{ type: "text", text: questionSetPrompt(input) }] },
    ]);
    assert.deepEqual(body.providerOptions, {
      anthropic: { effort: "low", disableParallelToolUse: true },
      gateway: { only: ["anthropic"] },
    });
    assert.deepEqual(GATEWAY_ROUTING, { only: ["anthropic"] });
    for (const key of ["temperature", "topP", "topK", "responseFormat"]) assert.equal(key in body, false, key);
  });

  it("sends the solo system prompt when asked", async () => {
    const { model, sent } = adapter(() => generated(QUESTIONS_TOOL_NAME, { questions: THREE }));
    await writeQuestionSet(model, { bodyText: BODY, gradeLevel: "9", count: 3 }, { audience: "solo" });
    assert.deepEqual((sent[0].body.prompt as { content: unknown }[])[0], { role: "system", content: SOLO_QUESTIONS_SYSTEM_PROMPT });
  });

  it("sends the effort check with its own tool and limit", async () => {
    const { model, sent } = adapter(() =>
      generated(EFFORT_TOOL.name, { results: [{ answer: 1, pass: false, nudge: "Look at where the fox went." }] }),
    );
    const items = [{ questionId: "q1", question: "Why did the fox run?", answer: "idk" }];
    const verdicts = await checkEffort(model, { bodyText: BODY, gradeLevel: "3", items });
    assert.deepEqual(verdicts, [{ questionId: "q1", pass: false, nudge: "Look at where the fox went." }]);
    const { body } = sent[0];
    assert.equal(body.maxOutputTokens, 6_000);
    assert.equal((body.tools as { name: string; strict: boolean }[])[0].name, EFFORT_TOOL.name);
    assert.equal((body.tools as { strict: boolean }[])[0].strict, true);
    assert.deepEqual(body.prompt, [
      { role: "system", content: EFFORT_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: effortCheckPrompt({
              bodyText: BODY,
              gradeLevel: "3",
              items: [{ number: 1, question: "Why did the fox run?", answer: "idk" }],
            }),
          },
        ],
      },
    ]);
  });

  it("passes the reply's tool calls and finish reasons back", async () => {
    const { model } = adapter(() => generated(QUESTIONS_TOOL_NAME, { questions: ["A?"] }, "refusal"));
    const reply = await model.create(
      {
        model: MODEL,
        system: "s",
        messages: [{ role: "user", content: "u" }],
        tool: QUESTIONS_TOOL,
        maxOutputTokens: 10,
        effort: "low",
      },
      { signal: new AbortController().signal },
    );
    assert.equal(reply.rawFinishReason, "refusal");
    assert.deepEqual(reply.toolCalls, [{ toolName: QUESTIONS_TOOL_NAME, input: { questions: ["A?"] } }]);
  });

  it("returns an unparsable tool call as invalid, so it counts as a reply and is retried with a note", async () => {
    let n = 0;
    const { model, sent } = adapter(() => {
      n++;
      if (n === 1) {
        return Response.json({
          content: [{ type: "tool-call", toolCallId: "c", toolName: QUESTIONS_TOOL_NAME, input: '{"questions": [' }],
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          warnings: [],
        });
      }
      return generated(QUESTIONS_TOOL_NAME, { questions: THREE });
    });
    assert.deepEqual(await writeQuestionSet(model, { bodyText: BODY, gradeLevel: "4", count: 3 }), THREE);
    assert.equal(sent.length, 2);
    const retryText = ((sent[1].body.prompt as { content: { text: string }[] }[])[1].content[0]).text;
    assert.match(retryText, /A previous answer was rejected/);
  });
});

describe("gateway credentials", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of ["VERCEL_OIDC_TOKEN", "AI_GATEWAY_API_KEY"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  // A made-up, unsigned token that isn't expired, so @vercel/oidc uses it
  // as is (no refresh, no network).
  const fakeOidc = () => {
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${part({ alg: "none" })}.${part({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  };

  it("uses OIDC without a key, and never reads AI_GATEWAY_API_KEY itself", async () => {
    const token = fakeOidc();
    process.env.VERCEL_OIDC_TOKEN = token;
    process.env.AI_GATEWAY_API_KEY = "not-used-by-the-adapter";
    const { model, sent } = adapter(() => generated(QUESTIONS_TOOL_NAME, { questions: THREE }), { apiKey: undefined });
    await writeQuestionSet(model, { bodyText: BODY, gradeLevel: "4", count: 3 });
    assert.equal(sent[0].headers.authorization, `Bearer ${token}`);
    assert.equal(sent[0].headers["ai-gateway-auth-method"], "oidc");
  });

  it("uses the key over OIDC when both are there", async () => {
    process.env.VERCEL_OIDC_TOKEN = fakeOidc();
    const { model, sent } = adapter(() => generated(QUESTIONS_TOOL_NAME, { questions: THREE }));
    await writeQuestionSet(model, { bodyText: BODY, gradeLevel: "4", count: 3 });
    assert.equal(sent[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal(sent[0].headers["ai-gateway-auth-method"], "api-key");
  });
});

describe("gateway failures", () => {
  const input = { bodyText: BODY, gradeLevel: "4" as const, count: 3 };
  // status, gateway error type, kind, whether the SDK retries it.
  const table: [number, string, string, boolean][] = [
    [401, "authentication_error", "not_configured", false],
    [402, "insufficient_funds", "not_configured", false],
    [403, "forbidden", "not_configured", false],
    [404, "model_not_found", "not_configured", false],
    [400, "invalid_request_error", "failed", false],
    [429, "rate_limit_exceeded", "busy", true],
    [529, "overloaded_error", "busy", true],
    [500, "internal_server_error", "failed", true],
    [503, "internal_server_error", "failed", true],
  ];

  for (const [status, type, kind, retried] of table) {
    it(`${status} ${type}: ${kind}, ${retried ? "after one SDK retry" : "with no retry"}`, async () => {
      const { model, sent } = adapter(() => gatewayError(status, type));
      await assert.rejects(writeQuestionSet(model, input), (error: unknown) => {
        assert.equal(questionErrorKind(error), kind);
        return true;
      });
      assert.equal(sent.length, retried ? 1 + AI_MAX_RETRIES : 1);
    });
  }

  it("a 401 is not set up whether or not NODE_ENV is production (generateText rewraps it)", async () => {
    const saved = process.env.NODE_ENV;
    try {
      for (const env of ["production", "development"]) {
        (process.env as Record<string, string>).NODE_ENV = env;
        const { model } = adapter(() => gatewayError(401, "authentication_error"));
        await assert.rejects(writeQuestionSet(model, input), (error: unknown) => {
          assert.equal(questionErrorKind(error), "not_configured", env);
          return true;
        });
      }
    } finally {
      if (saved === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
      else (process.env as Record<string, string>).NODE_ENV = saved;
    }
  });

  it("a network error: failed", async () => {
    const { model, sent } = adapter(
      () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
      },
      { maxRetries: 0 },
    );
    await assert.rejects(writeQuestionSet(model, input), (error: unknown) => questionErrorKind(error) === "failed");
    assert.equal(sent.length, 1);
  });

  it("a stuck request: cut off at the per-request timeout, retried once, then timeout", async () => {
    const { model, sent } = adapter(hang, { timeoutMs: 20 });
    await assert.rejects(writeQuestionSet(model, input), (error: unknown) => {
      assert.equal(questionErrorKind(error), "timeout");
      return true;
    });
    assert.equal(sent.length, 2);
    assert.ok(sent.every((s) => s.signal?.aborted));
  });

  it("the overall deadline aborts the in-flight request and maps to timeout", async () => {
    const { model, sent } = adapter(hang);
    const started = Date.now();
    await assert.rejects(writeQuestionSet(model, input, { deadlineMs: 30 }), (error: unknown) => {
      assert.equal(questionErrorKind(error), "timeout");
      return true;
    });
    assert.ok(Date.now() - started < 1_000);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].signal?.aborted, true);
  });

  it("the effort check's deadline does the same", async () => {
    const { model } = adapter(hang);
    const items = [{ questionId: "q1", question: "Why?", answer: "Because." }];
    await assert.rejects(
      checkEffort(model, { bodyText: BODY, gradeLevel: "3", items }, { deadlineMs: 30 }),
      (error: unknown) => questionErrorKind(error) === "timeout",
    );
  });
});

describe("withRequestTimeout", () => {
  it("gives each request its own timeout and keeps the caller's signal", async () => {
    const seen: AbortSignal[] = [];
    const base = (async (_input: unknown, init?: RequestInit) => {
      seen.push(init!.signal!);
      return new Response("ok");
    }) as typeof globalThis.fetch;
    const controller = new AbortController();
    const fetch = withRequestTimeout(1_000, base);
    await fetch("https://example.test", { signal: controller.signal });
    await fetch("https://example.test");
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0], controller.signal);
    controller.abort();
    assert.equal(seen[0].aborted, true);
    assert.equal(seen[1].aborted, false);
  });
});
