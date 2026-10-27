import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { buildEffortRequest, checkEffort } from "./effort-check";
import {
  EFFORT_SYSTEM_PROMPT,
  EFFORT_TOOL_NAME,
  effortSystemPrompt,
  NUDGE_MAX_LENGTH,
  SOLO_EFFORT_SYSTEM_PROMPT,
} from "./effort-prompts";
import {
  PRIVACY_RULE,
  QUESTION_MAX_LENGTH,
  QUESTIONS_SYSTEM_PROMPT,
  QUESTIONS_TOOL_NAME,
  questionsSystemPrompt,
  SOLO_PRIVACY_RULE,
  SOLO_QUESTIONS_SYSTEM_PROMPT,
} from "./prompts";
import { buildQuestionRequest, writeQuestionSet, type QuestionModel } from "./questions";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// Swaps every audience word for a placeholder, so the class and solo
// prompts can be compared for everything else (rules, format, levels).
function neutral(text: string): string {
  return text
    .replace(/A teacher assigned a reading\. After reading it, each student answers/, "INTRO answers")
    .replace(/The reader chose this reading themselves\. After reading it, the reader answers/, "INTRO answers")
    .replace(/A teacher assigned a reading and a few questions about it, and a student answered every question\./, "INTRO")
    .replace(/The reader chose a reading themselves, got a few questions about it, and answered every question\./, "INTRO")
    .replace(/(this |a |the )?(students'|students|readers|student|reader)('s)?/g, "WHO");
}

function fakeModel(response: unknown) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const model: QuestionModel = {
    model: "claude-sonnet-5-5",
    create: async (params) => {
      calls.push(params);
      return response as Anthropic.Message;
    },
  };
  return { model, calls };
}

describe("class prompts", () => {
  it("are unchanged, byte for byte", () => {
    assert.equal(sha256(QUESTIONS_SYSTEM_PROMPT), "ee5892acc9b3f8e2fef3922cb08c487331258234248f987efcc660fea93499cb");
    assert.equal(sha256(PRIVACY_RULE), "a87a719ac16fda21a40a27777afa5a46c5eb5a378511e038324837223aa99b20");
    assert.equal(sha256(EFFORT_SYSTEM_PROMPT), "771855db754b42e53010893fe227cb17b2cfb81440792eb18da349294886581e");
  });

  it("are the default audience", () => {
    assert.equal(questionsSystemPrompt(), QUESTIONS_SYSTEM_PROMPT);
    assert.equal(questionsSystemPrompt("class"), QUESTIONS_SYSTEM_PROMPT);
    assert.equal(effortSystemPrompt(), EFFORT_SYSTEM_PROMPT);
    assert.equal(effortSystemPrompt("class"), EFFORT_SYSTEM_PROMPT);
    assert.equal(buildQuestionRequest("m", "p").system, QUESTIONS_SYSTEM_PROMPT);
    assert.equal(buildEffortRequest("m", "p").system, EFFORT_SYSTEM_PROMPT);
  });
});

describe("solo prompts", () => {
  it("never mention a teacher or students", () => {
    for (const prompt of [SOLO_QUESTIONS_SYSTEM_PROMPT, SOLO_EFFORT_SYSTEM_PROMPT, SOLO_PRIVACY_RULE]) {
      assert.doesNotMatch(prompt, /teacher|student|class/i);
      assert.match(prompt, /reader/);
      assert.doesNotMatch(prompt, /[\u2013\u2014]/);
    }
  });

  it("say the reader chose the reading", () => {
    assert.match(SOLO_QUESTIONS_SYSTEM_PROMPT, /The reader chose this reading themselves/);
    assert.match(SOLO_EFFORT_SYSTEM_PROMPT, /The reader chose a reading themselves/);
  });

  it("keep every rule, the output format, and the level guidance", () => {
    assert.equal(neutral(SOLO_QUESTIONS_SYSTEM_PROMPT), neutral(QUESTIONS_SYSTEM_PROMPT));
    assert.equal(neutral(SOLO_EFFORT_SYSTEM_PROMPT), neutral(EFFORT_SYSTEM_PROMPT));
    assert.equal(neutral(SOLO_PRIVACY_RULE), neutral(PRIVACY_RULE));
    assert.ok(SOLO_QUESTIONS_SYSTEM_PROMPT.includes(`- ${SOLO_PRIVACY_RULE}`));
    assert.ok(SOLO_EFFORT_SYSTEM_PROMPT.includes(`- ${SOLO_PRIVACY_RULE}`));
    assert.match(SOLO_QUESTIONS_SYSTEM_PROMPT, new RegExp(`At most ${QUESTION_MAX_LENGTH} characters`));
    assert.match(SOLO_QUESTIONS_SYSTEM_PROMPT, new RegExp(`calling the ${QUESTIONS_TOOL_NAME} tool, exactly once`));
    assert.match(SOLO_QUESTIONS_SYSTEM_PROMPT, /Written for the grade level you are given/);
    assert.match(SOLO_EFFORT_SYSTEM_PROMPT, new RegExp(`At most ${NUDGE_MAX_LENGTH} characters`));
    assert.match(SOLO_EFFORT_SYSTEM_PROMPT, new RegExp(`calling the ${EFFORT_TOOL_NAME} tool, exactly once`));
    assert.match(SOLO_EFFORT_SYSTEM_PROMPT, /For a passed answer, the nudge is an empty string/);
    assert.match(SOLO_EFFORT_SYSTEM_PROMPT, /When you are unsure, pass it/);
  });

  it("are picked by the solo audience", () => {
    assert.equal(questionsSystemPrompt("solo"), SOLO_QUESTIONS_SYSTEM_PROMPT);
    assert.equal(effortSystemPrompt("solo"), SOLO_EFFORT_SYSTEM_PROMPT);
    assert.equal(buildQuestionRequest("m", "p", "solo").system, SOLO_QUESTIONS_SYSTEM_PROMPT);
    assert.equal(buildEffortRequest("m", "p", "solo").system, SOLO_EFFORT_SYSTEM_PROMPT);
  });
});

describe("audience option", () => {
  const questions = {
    content: [{ type: "tool_use", id: "t", name: QUESTIONS_TOOL_NAME, input: { questions: ["Why?", "What then?"] } }],
    stop_reason: "tool_use",
  };
  const effort = {
    content: [{ type: "tool_use", id: "t", name: EFFORT_TOOL_NAME, input: { results: [{ answer: 1, pass: true, nudge: "" }] } }],
    stop_reason: "tool_use",
  };
  const effortInput = { bodyText: "A fox ran.", gradeLevel: "7" as const, items: [{ questionId: "q1", question: "Why?", answer: "It was scared." }] };

  it("writeQuestionSet sends the solo prompt only when asked", async () => {
    const solo = fakeModel(questions);
    await writeQuestionSet(solo.model, { bodyText: "A fox ran.", gradeLevel: "7", count: 2 }, { audience: "solo" });
    assert.equal(solo.calls[0].system, SOLO_QUESTIONS_SYSTEM_PROMPT);
    const cls = fakeModel(questions);
    await writeQuestionSet(cls.model, { bodyText: "A fox ran.", gradeLevel: "7", count: 2 });
    assert.equal(cls.calls[0].system, QUESTIONS_SYSTEM_PROMPT);
  });

  it("checkEffort sends the solo prompt only when asked", async () => {
    const solo = fakeModel(effort);
    await checkEffort(solo.model, effortInput, { audience: "solo" });
    assert.equal(solo.calls[0].system, SOLO_EFFORT_SYSTEM_PROMPT);
    const cls = fakeModel(effort);
    await checkEffort(cls.model, effortInput);
    assert.equal(cls.calls[0].system, EFFORT_SYSTEM_PROMPT);
  });
});
