// Pure effort-check logic: request building, output validation, nudge
// cleanup, the one validation retry, and error mapping. One model call per
// attempt covers every answer. The model call is injected (a QuestionModel,
// the same client as question writing), so tests run it against a fake
// with no network.
//
// The check judges effort only: did the student genuinely try and engage
// with the text and the question. Never quality, spelling, grammar, or
// correctness (see EFFORT_SYSTEM_PROMPT).

import { z } from "zod";
import type { GradeLevel } from "../grade-levels";
import {
  EFFORT_TOOL_NAME,
  effortCheckPrompt,
  effortRetryNote,
  effortSystemPrompt,
  NUDGE_MAX_LENGTH,
} from "./effort-prompts";
import { isRefusal, wasCutOff, type ModelReply, type ModelRequest, type ToolSpec } from "./model";
import type { PromptAudience } from "./prompts";
import {
  questionErrorKind,
  questionErrorLogFields,
  untilAborted,
  type QuestionErrorKind,
  type QuestionModel,
} from "./questions";
import {
  EFFORT_CHECK_ATTEMPTS,
  EFFORT_CHECK_DEADLINE_MS,
  EFFORT_CHECK_EFFORT,
  EFFORT_CHECK_MAX_TOKENS,
} from "./settings";

// One question and the student's answer, in question order.
export type EffortItem = { questionId: string; question: string; answer: string };

export type EffortCheckInput = {
  bodyText: string;
  // The reading's effective grade (reading.grade_level ?? class grade).
  gradeLevel: GradeLevel;
  items: EffortItem[];
};

// The nudge is "" for a pass, and a short hint for a fail.
export type EffortVerdict = { questionId: string; pass: boolean; nudge: string };

// Plain fields, not parameter properties (see QuestionWriterError).
export class EffortCheckError extends Error {
  readonly kind: QuestionErrorKind;
  readonly reason: string;
  constructor(kind: QuestionErrorKind, reason: string) {
    super(`effort check: ${kind} (${reason})`);
    this.name = "EffortCheckError";
    this.kind = kind;
    this.reason = reason;
  }
}

export function effortErrorKind(error: unknown): QuestionErrorKind {
  return error instanceof EffortCheckError ? error.kind : questionErrorKind(error);
}

// Fields that are safe to log: no reading text, answers, prompts, or names.
export function effortErrorLogFields(error: unknown): Record<string, unknown> {
  const fields = questionErrorLogFields(error);
  fields.kind = effortErrorKind(error);
  if (error instanceof EffortCheckError) fields.reason = error.reason;
  return fields;
}

// Anything much longer than a nudge means the model ignored the rules, so
// it is invalid output (retried), not something to shorten.
const NUDGE_RAW_MAX_LENGTH = 400;

// The shortest cut at a sentence end that cleanNudge will keep, so a
// shortened nudge is still a useful hint and not just "Look again."
const SENTENCE_CUT_MIN = 40;

const DASHES_RE = /[\u2012\u2013\u2014\u2015\u2e3a\u2e3b\ufe58\ufe63\uff0d]/;

// Makes a model nudge fit what students see: no control characters, no em
// or en dashes (a number range with a dash becomes "3 to 5", any other dash a
// comma), single spaces, curly apostrophes inside words, and at most
// NUDGE_MAX_LENGTH characters. Too long, it ends at the last whole
// sentence that fits, or else at a word, with "…".
export function cleanNudge(raw: string): string {
  let s = raw.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  s = s.replace(new RegExp(`(\\d)\\s*${DASHES_RE.source}\\s*(\\d)`, "g"), "$1 to $2");
  s = s.replace(new RegExp(`\\s*${DASHES_RE.source}+\\s*`, "g"), ", ");
  s = s
    .replace(/\s+/g, " ")
    .replace(/(\p{L})'(\p{L})/gu, "$1’$2")
    .replace(/,(\s*,)+/g, ",")
    .replace(/\s*,\s*([.!?])/g, "$1")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/^[\s,]+|[\s,]+$/g, "");
  if (s.length <= NUDGE_MAX_LENGTH) return s;

  const head = s.slice(0, NUDGE_MAX_LENGTH);
  const sentenceEnds = [...head.matchAll(/[.!?](?=\s|$)/g)].map((m) => (m.index ?? 0) + 1);
  const lastEnd = sentenceEnds.at(-1);
  if (lastEnd && lastEnd >= SENTENCE_CUT_MIN) return head.slice(0, lastEnd);
  const room = s.slice(0, NUDGE_MAX_LENGTH - 1);
  const space = room.lastIndexOf(" ");
  const cut = space > 0 ? room.slice(0, space) : room;
  return `${cut.replace(/[\s,]+$/, "")}…`;
}

// The tool's input. Validated with zod even with strict tool use on: the
// count, numbering, and nudge rules aren't expressible in a strict schema.
export function effortOutputSchema(count: number) {
  const result = z.object({
    answer: z.number().int(),
    pass: z.boolean(),
    nudge: z.string().max(NUDGE_RAW_MAX_LENGTH, "a nudge was far too long"),
  });
  return z.object({
    results: z
      .array(result)
      .length(count, `expected exactly ${count} result${count === 1 ? "" : "s"}`)
      .superRefine((results, ctx) => {
        const seen = new Set<number>();
        for (const r of results) {
          if (r.answer < 1 || r.answer > count) {
            ctx.addIssue({ code: "custom", message: `there is no answer ${r.answer}` });
            return;
          }
          if (seen.has(r.answer)) {
            ctx.addIssue({ code: "custom", message: `answer ${r.answer} appeared twice` });
            return;
          }
          seen.add(r.answer);
          if (!r.pass && !cleanNudge(r.nudge)) {
            ctx.addIssue({ code: "custom", message: `failed answer ${r.answer} had no nudge` });
            return;
          }
        }
      }),
  });
}

// JSON Schema for the tool. Strict tool use keeps the input to this shape.
export const EFFORT_TOOL: ToolSpec = {
  name: EFFORT_TOOL_NAME,
  description:
    "Submit the effort check: one result for every answer. Call this exactly once.",
  strict: true,
  inputSchema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        description: "One result per answer, in any order.",
        items: {
          type: "object",
          properties: {
            answer: { type: "integer", description: "The answer's number." },
            pass: { type: "boolean", description: "True if the student genuinely tried." },
            nudge: {
              type: "string",
              description: `For a fail, a short kind hint (at most ${NUDGE_MAX_LENGTH} characters). Empty for a pass.`,
            },
          },
          required: ["answer", "pass", "nudge"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  },
};

export type ParsedEffort =
  | { ok: true; verdicts: { pass: boolean; nudge: string }[] }
  | { ok: false; problem: string };

// Pulls the verdicts out of a reply, in answer order (index 0 is answer
// 1). The tool call is found by name, as in parseQuestionsResponse.
export function parseEffortResponse(
  reply: ModelReply,
  count: number,
): ParsedEffort {
  if (isRefusal(reply)) {
    return { ok: false, problem: "the model declined" };
  }
  const call = reply.toolCalls.find((c) => c.toolName === EFFORT_TOOL_NAME);
  if (!call) {
    return {
      ok: false,
      problem: wasCutOff(reply)
        ? "the answer was cut off before the tool call"
        : `no ${EFFORT_TOOL_NAME} tool call`,
    };
  }
  const parsed = effortOutputSchema(count).safeParse(call.input);
  if (!parsed.success) {
    return { ok: false, problem: parsed.error.issues[0]?.message ?? "invalid tool input" };
  }
  const verdicts = [...parsed.data.results]
    .sort((a, b) => a.answer - b.answer)
    .map((r) => ({ pass: r.pass, nudge: r.pass ? "" : cleanNudge(r.nudge) }));
  return { ok: true, verdicts };
}

// Same request shape and reasons as buildQuestionRequest: auto tool choice
// (forcing a tool is a 400 on current models), no temperature, no prefill.
export function buildEffortRequest(
  model: string,
  userPrompt: string,
  audience: PromptAudience = "class",
): ModelRequest {
  return {
    model,
    system: effortSystemPrompt(audience),
    messages: [{ role: "user", content: userPrompt }],
    tool: EFFORT_TOOL,
    maxOutputTokens: EFFORT_CHECK_MAX_TOKENS,
    effort: EFFORT_CHECK_EFFORT,
  };
}

export type EffortCheckOptions = {
  // Tests pass a short deadline; the app uses EFFORT_CHECK_DEADLINE_MS.
  deadlineMs?: number;
  // "solo" for a self-learner's reading; class readings leave it out.
  audience?: PromptAudience;
};

// Every answer in one call, and once more if the output is invalid. One
// deadline covers it all, as in writeValidated. Gateway errors reach the
// caller (the SDK has already retried them).
export async function checkEffort(
  model: QuestionModel,
  input: EffortCheckInput,
  options: EffortCheckOptions = {},
): Promise<EffortVerdict[]> {
  const count = input.items.length;
  if (count === 0) throw new EffortCheckError("failed", "no answers to check");
  const prompt = effortCheckPrompt({
    bodyText: input.bodyText,
    gradeLevel: input.gradeLevel,
    items: input.items.map((item, i) => ({ number: i + 1, question: item.question, answer: item.answer })),
  }, options.audience);
  const signal = AbortSignal.timeout(options.deadlineMs ?? EFFORT_CHECK_DEADLINE_MS);
  let problem: string | undefined;
  for (let attempt = 0; attempt < EFFORT_CHECK_ATTEMPTS; attempt++) {
    signal.throwIfAborted();
    const text = problem ? prompt + effortRetryNote(problem) : prompt;
    const response = await untilAborted(
      model.create(buildEffortRequest(model.model, text, options.audience), { signal }),
      signal,
    );
    const parsed = parseEffortResponse(response, count);
    if (parsed.ok) {
      return parsed.verdicts.map((v, i) => ({ questionId: input.items[i].questionId, ...v }));
    }
    problem = parsed.problem;
  }
  throw new EffortCheckError("failed", `invalid output: ${problem}`);
}
