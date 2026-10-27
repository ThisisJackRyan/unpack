// The real model call: the AI SDK's generateText through Vercel AI
// Gateway, still Claude. Turns a ModelRequest into the SDK call and the
// result back into a ModelReply. No "server-only" here so tests can drive
// it with a fake fetch; only client.ts (server-only) builds it with real
// credentials.

import { createGateway, type GatewayProviderOptions } from "@ai-sdk/gateway";
import type { AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
import { generateText, jsonSchema, tool } from "ai";
import type { ModelCall, ModelReply, ModelRequest } from "./model";

type Fetch = typeof globalThis.fetch;

// Every HTTP request to the gateway gets its own timeout, the way the
// Anthropic SDK's `timeout` worked: each SDK try is cut off after
// timeoutMs, and the overall deadline (the caller's signal) still covers
// everything. A cut-off try is retried like a network error.
export function withRequestTimeout(timeoutMs: number, base: Fetch = globalThis.fetch): Fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return base(input, { ...init, signal });
  };
}

export type GatewayCallOptions = {
  // An AI Gateway API key, or undefined to use OIDC. Passed as "" then, so
  // the provider never falls back to reading AI_GATEWAY_API_KEY itself.
  apiKey?: string;
  timeoutMs: number;
  maxRetries: number;
  // Tests pass a fake; the app uses the global fetch.
  fetch?: Fetch;
};

// Keeps calls on Anthropic, as before the gateway: without it, the
// gateway may route an anthropic/ model to another host of Claude (Amazon
// Bedrock, Google Vertex AI), which would be another processor.
export const GATEWAY_ROUTING = { only: ["anthropic"] } satisfies GatewayProviderOptions;

// The provider options the gateway applies on its Anthropic call.
// effort: output_config.effort, as before. disableParallelToolUse: with
// auto tool choice, tool_choice {type: "auto", disable_parallel_tool_use:
// true}, as before. No thinking setting: the default (adaptive) stays, as
// before.
export function anthropicOptions(request: ModelRequest) {
  return {
    effort: request.effort,
    disableParallelToolUse: true,
  } satisfies AnthropicLanguageModelOptions;
}

export function createGatewayCall(options: GatewayCallOptions): ModelCall {
  const provider = createGateway({
    apiKey: options.apiKey ?? "",
    fetch: withRequestTimeout(options.timeoutMs, options.fetch),
  });
  return async (request, { signal }): Promise<ModelReply> => {
    const { tool: spec } = request;
    const result = await generateText({
      model: provider(request.model),
      instructions: request.system,
      messages: request.messages,
      tools: {
        // No execute: the call is the answer. jsonSchema without a
        // validator, so a call that doesn't match still comes back (the
        // cores validate it with zod and retry once, as before).
        [spec.name]: tool({
          description: spec.description,
          strict: spec.strict,
          inputSchema: jsonSchema(spec.inputSchema),
        }),
      },
      // Auto, not forced: see buildQuestionRequest.
      toolChoice: "auto",
      maxOutputTokens: request.maxOutputTokens,
      maxRetries: options.maxRetries,
      abortSignal: signal,
      providerOptions: {
        anthropic: anthropicOptions(request),
        gateway: GATEWAY_ROUTING,
      },
    });
    return {
      finishReason: result.finishReason,
      rawFinishReason: result.rawFinishReason,
      toolCalls: result.toolCalls.map((call) => ({
        toolName: call.toolName,
        input: call.input,
        ...(call.invalid ? { invalid: true } : {}),
      })),
    };
  };
}
