// Pure question-writing logic: request building, output validation, the
// one validation retry, and error mapping. The model call is injected, so
// tests run it against a fake with no network. The real call goes through
// Vercel AI Gateway (gateway-adapter.ts, built in client.ts, server-only).

import { z } from "zod";
import type { GradeLevel } from "../grade-levels";
import { questionErrorKind, QuestionWriterError, type QuestionErrorKind } from "./errors";
import { isRefusal, wasCutOff, type ModelReply, type ModelRequest, type QuestionModel, type ToolSpec } from "./model";
import {
  QUESTION_MAX_LENGTH,
  QUESTIONS_TOOL_NAME,
  questionSetPrompt,
  questionsSystemPrompt,
  replacementPrompt,
  retryNote,
  type PromptAudience,
} from "./prompts";
import {
  QUESTION_EFFORT,
  QUESTION_MAX_TOKENS,
  QUESTION_WRITE_ATTEMPTS,
  QUESTION_WRITE_DEADLINE_MS,
} from "./settings";

// The error kinds, messages, and mapping live in errors.ts; the seam types
// in model.ts. Re-exported here, where the callers already import them.
export {
  QUESTION_ERROR_MESSAGES,
  QuestionWriterError,
  questionErrorClass,
  questionErrorKind,
  questionErrorLogFields,
  type QuestionErrorClass,
  type QuestionErrorKind,
} from "./errors";
export type { ModelCall, ModelReply, ModelRequest, QuestionModel } from "./model";

// Collapses case and spacing so "Why did Mia leave?" and "why did mia
// leave ?" count as the same question.
export function questionKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const questionText = z
  .string()
  .trim()
  .min(1, "a question was empty")
  .max(QUESTION_MAX_LENGTH, `a question was over ${QUESTION_MAX_LENGTH} characters`);

// The tool's input. Validated with zod even with strict tool use on: the
// count, lengths, and duplicates aren't expressible in a strict schema, and
// we can't test against the live API, so we trust nothing.
export function questionsOutputSchema(count: number, avoid: string[] = []) {
  const avoidKeys = new Set(avoid.map(questionKey));
  return z.object({
    questions: z
      .array(questionText)
      .length(count, `expected exactly ${count} question${count === 1 ? "" : "s"}`)
      .superRefine((questions, ctx) => {
        const seen = new Set<string>();
        for (const q of questions) {
          const key = questionKey(q);
          if (seen.has(key) || avoidKeys.has(key)) {
            ctx.addIssue({ code: "custom", message: "two questions were the same" });
            return;
          }
          seen.add(key);
        }
      }),
  });
}

// JSON Schema for the tool. Strict tool use keeps the input to this shape.
export const QUESTIONS_TOOL: ToolSpec = {
  name: QUESTIONS_TOOL_NAME,
  description:
    "Submit the finished questions, in order. Call this exactly once with every question.",
  strict: true,
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: { type: "string" },
        description: "The questions, in order, one string each.",
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
};

export type ParsedQuestions =
  | { ok: true; questions: string[] }
  | { ok: false; problem: string };

// Pulls the questions out of a reply. The tool call is found by name, not
// by position: the model may write a sentence before calling the tool.
export function parseQuestionsResponse(
  reply: ModelReply,
  count: number,
  avoid: string[] = [],
): ParsedQuestions {
  if (isRefusal(reply)) {
    return { ok: false, problem: "the model declined" };
  }
  const call = reply.toolCalls.find((c) => c.toolName === QUESTIONS_TOOL_NAME);
  if (!call) {
    return {
      ok: false,
      problem: wasCutOff(reply)
        ? "the answer was cut off before the tool call"
        : `no ${QUESTIONS_TOOL_NAME} tool call`,
    };
  }
  const parsed = questionsOutputSchema(count, avoid).safeParse(call.input);
  if (!parsed.success) {
    return { ok: false, problem: parsed.error.issues[0]?.message ?? "invalid tool input" };
  }
  return { ok: true, questions: parsed.data.questions };
}

// Request shape. Things current models reject are left out on purpose:
// no temperature/top_p/top_k and no assistant prefill (both 400), and no
// thinking setting (the default is adaptive thinking; turning it off is a
// 400 on some current models).
//
// Tool choice is "auto", not forced (the adapter sends toolChoice "auto"
// with parallel tool use off). Forcing a tool ({type: "tool"} or "any")
// returns a 400 on current models such as claude-sonnet-5-5 and
// claude-opus-5-5, and conflicts with thinking on others. So the system
// prompt tells the model to answer only through the tool, strict: true
// keeps the call's input to the schema, and a reply without the call is
// treated as invalid output and retried once.
export function buildQuestionRequest(
  model: string,
  userPrompt: string,
  audience: PromptAudience = "class",
): ModelRequest {
  return {
    model,
    system: questionsSystemPrompt(audience),
    messages: [{ role: "user", content: userPrompt }],
    tool: QUESTIONS_TOOL,
    maxOutputTokens: QUESTION_MAX_TOKENS,
    effort: QUESTION_EFFORT,
  };
}

// How a write went, for the questions.generate log (timing-log.ts):
// "ok", "invalid" (no usable output after every attempt), or the error's
// kind. attempts counts model calls started (QUESTION_WRITE_ATTEMPTS at
// most); httpRequests counts HTTP requests to the gateway, SDK retries
// included, when the model reports them (0 otherwise).
export type WriteOutcome = "ok" | "invalid" | QuestionErrorKind;
export type WriteReport = { outcome: WriteOutcome; durationMs: number; attempts: number; httpRequests: number };

export type WriteOptions = {
  // Tests pass a short deadline; the app uses QUESTION_WRITE_DEADLINE_MS.
  deadlineMs?: number;
  // "solo" for a self-learner's reading; class readings leave it out.
  audience?: PromptAudience;
  // Called once when the write ends, with or without questions.
  onReport?: (report: WriteReport) => void;
  // Monotonic milliseconds for durationMs; tests pass a fake.
  now?: () => number;
};

// Settles with the call, or rejects as soon as the signal fires, so the
// deadline holds even if a call doesn't honor its signal. Also used by the
// effort check (effort-check.ts).
export function untilAborted<T>(call: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    call.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// Calls the model, and once more if the output is invalid. Each try is a
// fresh request with a note on what was wrong: we never echo the rejected
// answer back, so no thinking blocks are replayed. Gateway errors are not
// caught here (the SDK has already retried them); they reach the caller.
//
// One deadline covers everything (see QUESTION_WRITE_DEADLINE_MS). When it
// fires, the in-flight call is aborted and the write throws a timeout.
async function writeValidated(
  model: QuestionModel,
  prompt: string,
  count: number,
  avoid: string[],
  options: WriteOptions,
): Promise<string[]> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  let attempts = 0;
  let httpRequests = 0;
  // A throwing reporter must not fail a good write or replace its error.
  const report = (outcome: WriteOutcome) => {
    try {
      options.onReport?.({ outcome, durationMs: Math.round(now() - started), attempts, httpRequests });
    } catch {
      // The report is lost; the write's result stands.
    }
  };
  const signal = AbortSignal.timeout(options.deadlineMs ?? QUESTION_WRITE_DEADLINE_MS);
  let problem: string | undefined;
  try {
    for (let attempt = 0; attempt < QUESTION_WRITE_ATTEMPTS; attempt++) {
      signal.throwIfAborted();
      attempts++;
      const text = problem ? prompt + retryNote(problem) : prompt;
      const response = await untilAborted(
        model.create(buildQuestionRequest(model.model, text, options.audience), {
          signal,
          onRequest: () => httpRequests++,
        }),
        signal,
      );
      const parsed = parseQuestionsResponse(response, count, avoid);
      if (parsed.ok) {
        report("ok");
        return parsed.questions;
      }
      problem = parsed.problem;
    }
  } catch (error) {
    report(questionErrorKind(error));
    throw error;
  }
  report("invalid");
  throw new QuestionWriterError("failed", `invalid output: ${problem}`);
}

export type QuestionSetInput = {
  bodyText: string;
  gradeLevel: GradeLevel;
  count: number;
};

export function writeQuestionSet(
  model: QuestionModel,
  input: QuestionSetInput,
  options: WriteOptions = {},
): Promise<string[]> {
  return writeValidated(model, questionSetPrompt(input, options.audience), input.count, [], options);
}

export type ReplacementInput = {
  bodyText: string;
  gradeLevel: GradeLevel;
  // 1-based position of the question being replaced, and the set size.
  position: number;
  count: number;
  // Every question currently in the set, in order, including the one
  // being replaced.
  current: string[];
};

// One new question for a position, keeping that position's role. It must
// not match any current question, including the one it replaces.
export async function writeReplacementQuestion(
  model: QuestionModel,
  input: ReplacementInput,
  options: WriteOptions = {},
): Promise<string> {
  const replacing = input.current[input.position - 1] ?? "";
  const others = input.current.filter((_, i) => i !== input.position - 1);
  const prompt = replacementPrompt({
    bodyText: input.bodyText,
    gradeLevel: input.gradeLevel,
    position: input.position,
    count: input.count,
    replacing,
    others,
  }, options.audience);
  const [question] = await writeValidated(model, prompt, 1, input.current, options);
  return question;
}
