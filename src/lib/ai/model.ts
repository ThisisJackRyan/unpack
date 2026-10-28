// The model seam: what the pure cores (questions.ts, effort-check.ts) send
// and get back, in plain terms. The real call goes through Vercel AI
// Gateway (gateway-adapter.ts); tests and the db:check scripts pass a fake
// with no network. Type imports only, so anything can use it.

import type { JSONSchema7 } from "ai";

// JSON Schema for a tool's input, kept to what strict tool use accepts.
export type ToolInputSchema = JSONSchema7 & {
  type: "object";
  properties: Record<string, JSONSchema7>;
  required: string[];
  additionalProperties: false;
};

// The one tool the model answers through. Strict tool use keeps the call's
// input to the schema.
export type ToolSpec = {
  name: string;
  description: string;
  strict: true;
  inputSchema: ToolInputSchema;
};

export type ModelEffort = "low" | "medium" | "high";

// One request: a system prompt, one user message, one tool. The adapter
// sends the tool with auto tool choice and parallel tool use off (see
// buildQuestionRequest for why it isn't forced).
export type ModelRequest = {
  model: string;
  system: string;
  messages: [{ role: "user"; content: string }];
  tool: ToolSpec;
  maxOutputTokens: number;
  effort: ModelEffort;
};

// A tool call from the reply. invalid is set when the SDK couldn't parse
// it (unparsable input, or a tool we didn't offer); input is then the raw
// text or whatever could be parsed.
export type ModelToolCall = { toolName: string; input: unknown; invalid?: boolean };

// The AI SDK's unified finish reason, and the provider's own (Anthropic's
// stop_reason, e.g. "refusal" or "max_tokens") when the gateway passes it.
export type ModelReply = {
  finishReason: string;
  rawFinishReason?: string;
  toolCalls: ModelToolCall[];
};

// The signal is the overall deadline. The SDK checks it before each try
// and wakes from its backoff sleep when it fires. onRequest, if given, is
// called for each HTTP request the call makes (SDK retries included), for
// the questions.generate log; fakes may ignore it.
export type ModelCall = (
  request: ModelRequest,
  options: { signal: AbortSignal; onRequest?: () => void },
) => Promise<ModelReply>;

export type QuestionModel = { model: string; create: ModelCall };

// Anthropic reports a refusal as stop_reason "refusal"; the AI SDK maps it
// to "content-filter".
export function isRefusal(reply: Pick<ModelReply, "finishReason" | "rawFinishReason">): boolean {
  return reply.rawFinishReason === "refusal" || reply.finishReason === "content-filter";
}

// The reply ran out of output tokens (stop_reason "max_tokens").
export function wasCutOff(reply: Pick<ModelReply, "finishReason" | "rawFinishReason">): boolean {
  return reply.finishReason === "length" || reply.rawFinishReason === "max_tokens";
}
