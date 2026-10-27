// Pure question-writing logic: request building, output validation, the
// one validation retry, and error mapping. The model call is injected, so
// tests run it against a fake with no network. The real client is in
// client.ts (server-only).

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { GradeLevel } from "../grade-levels";
import {
  QUESTION_MAX_LENGTH,
  QUESTIONS_SYSTEM_PROMPT,
  QUESTIONS_TOOL_NAME,
  questionSetPrompt,
  replacementPrompt,
  retryNote,
} from "./prompts";
import {
  QUESTION_EFFORT,
  QUESTION_MAX_TOKENS,
  QUESTION_WRITE_ATTEMPTS,
  QUESTION_WRITE_DEADLINE_MS,
} from "./settings";

// The signal is the write's overall deadline. The SDK checks it before each
// try and wakes from its backoff sleep when it fires.
export type MessagesCreate = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  options: { signal: AbortSignal },
) => Promise<Anthropic.Message>;

export type QuestionModel = { model: string; create: MessagesCreate };

// What went wrong, in the terms the teacher's message needs.
export type QuestionErrorKind =
  | "not_configured"
  | "busy"
  | "timeout"
  | "failed";

export const QUESTION_ERROR_MESSAGES: Record<QuestionErrorKind, string> = {
  not_configured: "Question writing isn’t set up yet.",
  busy: "Question writing is busy right now. Try again in a minute.",
  timeout: "That took too long. Try again.",
  failed: "We couldn’t write questions this time. Try again.",
};

// Plain fields, not parameter properties: Node's type stripping (used by
// the tests) doesn't support those.
export class QuestionWriterError extends Error {
  readonly kind: QuestionErrorKind;
  readonly reason: string;
  constructor(kind: QuestionErrorKind, reason: string) {
    super(`question writer: ${kind} (${reason})`);
    this.name = "QuestionWriterError";
    this.kind = kind;
    this.reason = reason;
  }
}

// Maps anything thrown while writing questions to an error kind.
// Most specific first: a timeout is a connection error, a 529 is an
// InternalServerError, and the SDK's abort error is an APIError (the only
// abort is the write deadline, so it's a timeout).
export function questionErrorKind(error: unknown): QuestionErrorKind {
  if (error instanceof QuestionWriterError) return error.kind;
  if (
    error instanceof Anthropic.APIConnectionTimeoutError ||
    error instanceof Anthropic.APIUserAbortError
  ) {
    return "timeout";
  }
  // The deadline's own reason (TimeoutError), or a plain fetch abort.
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timeout";
  }
  if (error instanceof Anthropic.APIConnectionError) return "failed";
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError ||
    // A model name the API doesn't know: ANTHROPIC_MODEL is wrong.
    error instanceof Anthropic.NotFoundError
  ) {
    return "not_configured";
  }
  if (error instanceof Anthropic.RateLimitError) return "busy";
  if (error instanceof Anthropic.APIError) {
    if (error.status === 529 || error.type === "overloaded_error") return "busy";
    return "failed";
  }
  return "failed";
}

// Fields that are safe to log: no reading text, prompts, keys, or names.
export function questionErrorLogFields(error: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    kind: questionErrorKind(error),
    name: error instanceof Error ? error.name : typeof error,
  };
  if (error instanceof QuestionWriterError) fields.reason = error.reason;
  if (error instanceof Anthropic.APIError) {
    fields.status = error.status;
    fields.type = error.type;
    fields.requestId = error.requestID;
  }
  return fields;
}

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
export const QUESTIONS_TOOL: Anthropic.Tool = {
  name: QUESTIONS_TOOL_NAME,
  description:
    "Submit the finished questions, in order. Call this exactly once with every question.",
  strict: true,
  input_schema: {
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

// Pulls the questions out of a response. The tool call is found by type and
// name, not by position: with thinking on, content can start with thinking
// blocks, and the model may write a sentence before calling the tool.
export function parseQuestionsResponse(
  response: Pick<Anthropic.Message, "content" | "stop_reason">,
  count: number,
  avoid: string[] = [],
): ParsedQuestions {
  if (response.stop_reason === "refusal") {
    return { ok: false, problem: "the model declined" };
  }
  const call = response.content.find(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === "tool_use" && block.name === QUESTIONS_TOOL_NAME,
  );
  if (!call) {
    return {
      ok: false,
      problem:
        response.stop_reason === "max_tokens"
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
// tool_choice is "auto", not forced. Forcing a tool ({type: "tool"} or
// "any") returns a 400 on current models such as claude-sonnet-5-5 and
// claude-opus-5-5, and conflicts with thinking on others. So the system
// prompt tells the model to answer only through the tool, strict: true
// keeps the call's input to the schema, and a response without the call is
// treated as invalid output and retried once.
export function buildQuestionRequest(
  model: string,
  userPrompt: string,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: QUESTION_MAX_TOKENS,
    system: QUESTIONS_SYSTEM_PROMPT,
    tools: [QUESTIONS_TOOL],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    output_config: { effort: QUESTION_EFFORT },
    messages: [{ role: "user", content: userPrompt }],
  };
}

export type WriteOptions = {
  // Tests pass a short deadline; the app uses QUESTION_WRITE_DEADLINE_MS.
  deadlineMs?: number;
};

// Settles with the call, or rejects as soon as the signal fires, so the
// deadline holds even if a call doesn't honor its signal.
function untilAborted<T>(call: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    call.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// Calls the model, and once more if the output is invalid. Each try is a
// fresh request with a note on what was wrong: we never echo the rejected
// answer back, so no thinking blocks are replayed. API errors are not
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
  const signal = AbortSignal.timeout(options.deadlineMs ?? QUESTION_WRITE_DEADLINE_MS);
  let problem: string | undefined;
  for (let attempt = 0; attempt < QUESTION_WRITE_ATTEMPTS; attempt++) {
    signal.throwIfAborted();
    const text = problem ? prompt + retryNote(problem) : prompt;
    const response = await untilAborted(
      model.create(buildQuestionRequest(model.model, text), { signal }),
      signal,
    );
    const parsed = parseQuestionsResponse(response, count, avoid);
    if (parsed.ok) return parsed.questions;
    problem = parsed.problem;
  }
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
  return writeValidated(model, questionSetPrompt(input), input.count, [], options);
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
  });
  const [question] = await writeValidated(model, prompt, 1, input.current, options);
  return question;
}
