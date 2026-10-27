// Fakes for tests and the db:check scripts: model replies and the errors
// Vercel AI Gateway and the AI SDK really throw, built from the installed
// classes. No network. Not used by the app.

import {
  GatewayAuthenticationError,
  GatewayForbiddenError,
  GatewayInternalServerError,
  GatewayInvalidRequestError,
  GatewayModelNotFoundError,
  GatewayRateLimitError,
  GatewayResponseError,
} from "@ai-sdk/gateway";
import { AISDKError, APICallError, RetryError } from "ai";
import type { ModelReply } from "./model";

// A reply with one tool call. finishReason "tool-calls" and raw
// "tool_use" are what a normal call returns.
export function toolReply(toolName: string, input: unknown, finishReason = "tool-calls", rawFinishReason = "tool_use"): ModelReply {
  return { finishReason, rawFinishReason, toolCalls: [{ toolName, input }] };
}

// A reply with no tool call (text only, a refusal, or cut off).
export function noToolReply(finishReason = "stop", rawFinishReason = "end_turn"): ModelReply {
  return { finishReason, rawFinishReason, toolCalls: [] };
}

// What fetch throws when the network is down, wrapped the way the gateway
// provider does (APICallError "Cannot connect", then a 500
// GatewayResponseError).
export function networkError(): GatewayResponseError {
  const cause = new APICallError({
    message: "Cannot connect to API: connect ECONNREFUSED",
    url: "https://ai-gateway.vercel.sh/v4/ai/language-model",
    requestBodyValues: {},
    isRetryable: true,
  });
  return new GatewayResponseError({ message: "Invalid error response format: Gateway request failed", statusCode: 500, cause });
}

// A timed-out fetch (the per-request timeout), wrapped by the gateway.
export function requestTimeoutError(): GatewayResponseError {
  return new GatewayResponseError({
    message: "Invalid error response format: Gateway request failed: The operation was aborted due to timeout",
    statusCode: 500,
    cause: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
  });
}

// The SDK's error after its retries ran out.
export function retried(lastError: unknown): RetryError {
  return new RetryError({ message: "Failed after 2 attempts", reason: "maxRetriesExceeded", errors: [lastError, lastError] });
}

// One of each failure, as the gateway reports it.
export const gatewayErrors = {
  noCredentials: () =>
    GatewayAuthenticationError.createContextualError({ apiKeyProvided: false, oidcTokenProvided: false, statusCode: 401 }),
  badKey: () => GatewayAuthenticationError.createContextualError({ apiKeyProvided: true, oidcTokenProvided: false, statusCode: 401 }),
  // The gateway has no class for a 402 (out of credits): an unknown error
  // type comes back as a GatewayInternalServerError with the status.
  outOfCredits: () => new GatewayInternalServerError({ message: "insufficient funds", statusCode: 402 }),
  forbidden: () => new GatewayForbiddenError({ message: "forbidden", statusCode: 403 }),
  unknownModel: () => new GatewayModelNotFoundError({ message: "model not found", statusCode: 404, modelId: "anthropic/nope" }),
  badRequest: () => new GatewayInvalidRequestError({ message: "bad request", statusCode: 400 }),
  rateLimited: () => new GatewayRateLimitError({ message: "rate limited", statusCode: 429 }),
  overloaded: () => new GatewayInternalServerError({ message: "Overloaded", statusCode: 529 }),
  serverError: () => new GatewayInternalServerError({ message: "internal", statusCode: 500 }),
  unavailable: () => new GatewayInternalServerError({ message: "unavailable", statusCode: 503 }),
  // What generateText re-throws a 401 as (wrapGatewayError in ai).
  wrappedAuthDev: () => Object.assign(new Error("Unauthenticated request to AI Gateway."), { name: "GatewayAuthenticationError" }),
  wrappedAuthProduction: () => new AISDKError({ name: "GatewayError", message: "Unauthenticated." }),
  network: networkError,
  requestTimeout: requestTimeoutError,
};
