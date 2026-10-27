import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { EFFORT_TOOL_NAME, NUDGE_MAX_LENGTH } from "./effort-prompts";
import {
  buildEffortRequest,
  checkEffort,
  cleanNudge,
  EffortCheckError,
  effortErrorKind,
  effortErrorLogFields,
  EFFORT_TOOL,
  parseEffortResponse,
  type EffortCheckInput,
} from "./effort-check";
import type { QuestionModel } from "./questions";
import { EFFORT_CHECK_DEADLINE_MS, EFFORT_CHECK_EFFORT, EFFORT_CHECK_MAX_TOKENS } from "./settings";

const BODY = "Mia found a fox in the snow. ".repeat(20);

function toolUse(input: unknown, name = EFFORT_TOOL_NAME) {
  return { type: "tool_use", id: "toolu_1", name, input };
}

function message(content: unknown[], stop_reason = "tool_use") {
  return { content, stop_reason } as unknown as Anthropic.Message;
}

const r = (answer: number, pass: boolean, nudge = "") => ({ answer, pass, nudge });

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

const INPUT: EffortCheckInput = {
  bodyText: BODY,
  gradeLevel: "3",
  items: [
    { questionId: "q-a", question: "Why did Mia go out?", answer: "to see the snow" },
    { questionId: "q-b", question: "What did the fox do?", answer: "idk" },
    { questionId: "q-c", question: "What do you think Mia should do next?", answer: "help the fox" },
  ],
};

describe("cleanNudge", () => {
  it("keeps a short, clean nudge as it is", () => {
    assert.equal(cleanNudge("Look at the part where Mia finds the fox."), "Look at the part where Mia finds the fox.");
  });

  it("strips em and en dashes", () => {
    assert.equal(cleanNudge("Look again \u2014 what did the fox do?"), "Look again, what did the fox do?");
    assert.equal(cleanNudge("Reread the end\u2013then add why."), "Reread the end, then add why.");
    assert.equal(cleanNudge("Reread pages 3\u20135."), "Reread pages 3 to 5.");
    assert.equal(cleanNudge("\u2014 Look again \u2014"), "Look again");
    assert.doesNotMatch(cleanNudge("a \u2014 b \u2013 c \u2015 d"), /[\u2013\u2014\u2015]/);
  });

  it("drops control characters, extra spaces, and makes apostrophes curly", () => {
    assert.equal(cleanNudge("  Don't\n\tstop ,  say why . "), "Don’t stop, say why.");
  });

  it("shortens a long nudge to whole sentences that fit", () => {
    const first = "Look at the part where Mia finds the fox in the snow by the old barn.";
    const long = `${first} Then tell what the fox did next and why you think it did that, using your own words please.`;
    const cleaned = cleanNudge(long);
    assert.equal(cleaned, first);
    assert.ok(cleaned.length <= NUDGE_MAX_LENGTH);
  });

  it("cuts at a word with an ellipsis when no sentence fits", () => {
    const long = "Look again at ".concat("the snowy part of the story ".repeat(8));
    const cleaned = cleanNudge(long);
    assert.ok(cleaned.length <= NUDGE_MAX_LENGTH, String(cleaned.length));
    assert.match(cleaned, /\S…$/);
  });
});

describe("parseEffortResponse", () => {
  it("returns verdicts in answer order, whatever order the model used", () => {
    const p = parseEffortResponse(
      message([toolUse({ results: [r(3, true), r(1, true), r(2, false, "Look at what the fox did.")] })]),
      3,
    );
    assert.deepEqual(p, {
      ok: true,
      verdicts: [
        { pass: true, nudge: "" },
        { pass: false, nudge: "Look at what the fox did." },
        { pass: true, nudge: "" },
      ],
    });
  });

  it("finds the tool call after thinking and text blocks", () => {
    const p = parseEffortResponse(
      message([{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "Done." }, toolUse({ results: [r(1, true)] })]),
      1,
    );
    assert.equal(p.ok, true);
  });

  it("drops a nudge on a passed answer and cleans a failed one", () => {
    const p = parseEffortResponse(message([toolUse({ results: [r(1, true, "Great job!"), r(2, false, "Say why \u2014 use the text.")] })]), 2);
    assert.deepEqual(p, { ok: true, verdicts: [{ pass: true, nudge: "" }, { pass: false, nudge: "Say why, use the text." }] });
  });

  it("rejects a missing answer", () => {
    assert.deepEqual(parseEffortResponse(message([toolUse({ results: [r(1, true), r(2, true)] })]), 3), {
      ok: false,
      problem: "expected exactly 3 results",
    });
  });

  it("rejects a duplicate answer", () => {
    assert.deepEqual(parseEffortResponse(message([toolUse({ results: [r(1, true), r(1, true), r(2, true)] })]), 3), {
      ok: false,
      problem: "answer 1 appeared twice",
    });
  });

  it("rejects an extra or unknown answer number", () => {
    assert.equal(parseEffortResponse(message([toolUse({ results: [r(1, true), r(2, true), r(3, true), r(4, true)] })]), 3).ok, false);
    assert.deepEqual(parseEffortResponse(message([toolUse({ results: [r(1, true), r(2, true), r(4, true)] })]), 3), {
      ok: false,
      problem: "there is no answer 4",
    });
    assert.equal(parseEffortResponse(message([toolUse({ results: [r(0, true)] })]), 1).ok, false);
    assert.equal(parseEffortResponse(message([toolUse({ results: [r(1.5, true)] })]), 1).ok, false);
  });

  it("rejects a fail without a nudge, or with only dashes and spaces", () => {
    assert.deepEqual(parseEffortResponse(message([toolUse({ results: [r(1, false, "")] })]), 1), {
      ok: false,
      problem: "failed answer 1 had no nudge",
    });
    assert.equal(parseEffortResponse(message([toolUse({ results: [r(1, false, " \u2014 ")] })]), 1).ok, false);
  });

  it("rejects a nudge far over the limit instead of shortening it", () => {
    assert.equal(parseEffortResponse(message([toolUse({ results: [r(1, false, "x ".repeat(300))] })]), 1).ok, false);
  });

  it("rejects no tool call, a cut off answer, a refusal, and the wrong shape", () => {
    assert.deepEqual(parseEffortResponse(message([{ type: "text", text: "pass" }], "end_turn"), 1), {
      ok: false,
      problem: `no ${EFFORT_TOOL_NAME} tool call`,
    });
    assert.match(
      (parseEffortResponse(message([], "max_tokens"), 1) as { problem: string }).problem,
      /cut off/,
    );
    assert.equal(parseEffortResponse(message([toolUse({ results: [r(1, true)] })], "refusal"), 1).ok, false);
    assert.equal(parseEffortResponse(message([toolUse({ results: [r(1, true)] }, "submit_questions")]), 1).ok, false);
    for (const input of [{}, { results: "pass" }, { results: [{ answer: 1, pass: "yes", nudge: "" }] }, null]) {
      assert.equal(parseEffortResponse(message([toolUse(input)]), 1).ok, false);
    }
  });
});

describe("buildEffortRequest", () => {
  it("uses the strict tool, auto choice, and the effort check's own limits", () => {
    const req = buildEffortRequest("claude-sonnet-5-5", "prompt");
    assert.equal(req.max_tokens, EFFORT_CHECK_MAX_TOKENS);
    assert.deepEqual(req.output_config, { effort: EFFORT_CHECK_EFFORT });
    assert.deepEqual(req.tool_choice, { type: "auto", disable_parallel_tool_use: true });
    assert.deepEqual(req.tools, [EFFORT_TOOL]);
    assert.equal(EFFORT_TOOL.strict, true);
    assert.equal("temperature" in req, false);
    assert.equal(req.messages.length, 1);
  });
});

describe("checkEffort", () => {
  it("checks every answer in ONE call and maps verdicts to question ids", async () => {
    const { model, calls } = fakeModel([
      message([toolUse({ results: [r(1, true), r(2, false, "Look at what the fox did in the snow."), r(3, true)] })]),
    ]);
    const verdicts = await checkEffort(model, INPUT);
    assert.equal(calls.length, 1);
    assert.deepEqual(verdicts, [
      { questionId: "q-a", pass: true, nudge: "" },
      { questionId: "q-b", pass: false, nudge: "Look at what the fox did in the snow." },
      { questionId: "q-c", pass: true, nudge: "" },
    ]);
    const prompt = String(calls[0].messages[0].content);
    for (const item of INPUT.items) {
      assert.ok(prompt.includes(item.question));
      assert.ok(prompt.includes(item.answer));
    }
  });

  it("retries once on invalid output, with a note and without echoing the bad answer", async () => {
    const { model, calls } = fakeModel([
      message([toolUse({ results: [r(1, true)] })]),
      message([toolUse({ results: [r(1, true), r(2, true), r(3, true)] })]),
    ]);
    const verdicts = await checkEffort(model, INPUT);
    assert.equal(calls.length, 2);
    assert.ok(verdicts.every((v) => v.pass));
    const retry = String(calls[1].messages[0].content);
    assert.match(retry, /A previous answer was rejected: expected exactly 3 results/);
    assert.equal(calls[1].messages.length, 1);
  });

  it("fails after two invalid outputs", async () => {
    const bad = () => message([toolUse({ results: [r(1, false, "")] })]);
    const { model, calls } = fakeModel([bad(), bad()]);
    await assert.rejects(checkEffort(model, INPUT), (e: unknown) => e instanceof EffortCheckError && e.kind === "failed");
    assert.equal(calls.length, 2);
  });

  it("passes API errors through without a second call", async () => {
    const error = new Anthropic.RateLimitError(429, { type: "error" }, "slow down", new Headers());
    const { model, calls } = fakeModel([error]);
    await assert.rejects(checkEffort(model, INPUT), (e: unknown) => effortErrorKind(e) === "busy");
    assert.equal(calls.length, 1);
  });

  it("ends at the deadline, even if the call ignores its signal", async () => {
    // AbortSignal.timeout's timer doesn't hold the event loop open (see the
    // write deadline tests in questions.test.ts).
    const keepAlive = setInterval(() => {}, 1_000);
    try {
      const model: QuestionModel = { model: "m", create: () => new Promise(() => {}) };
      await assert.rejects(checkEffort(model, INPUT, { deadlineMs: 20 }), (e: unknown) => effortErrorKind(e) === "timeout");
    } finally {
      clearInterval(keepAlive);
    }
    assert.equal(EFFORT_CHECK_DEADLINE_MS, 60_000);
  });

  it("refuses to call the model with no answers", async () => {
    const { model, calls } = fakeModel([]);
    await assert.rejects(checkEffort(model, { ...INPUT, items: [] }), EffortCheckError);
    assert.equal(calls.length, 0);
  });

  it("logs safe fields only", () => {
    const fields = effortErrorLogFields(new EffortCheckError("failed", "invalid output: x"));
    assert.deepEqual(fields, { kind: "failed", name: "EffortCheckError", reason: "invalid output: x" });
  });
});
