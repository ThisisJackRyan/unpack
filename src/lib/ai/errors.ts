// What went wrong with a model call, in the terms the user's message
// needs, mapped from Vercel AI Gateway and AI SDK errors. Shared by
// question writing and the effort check.
//
// The kind only picks the message. Whether a failed write counts toward a
// limit depends on whether a model reply arrived (see failureCounts in
// student-questions-core.ts), not on the kind.

import {
  GatewayAuthenticationError,
  GatewayError,
  GatewayForbiddenError,
  GatewayModelNotFoundError,
  GatewayNotFoundError,
  GatewayRateLimitError,
} from "@ai-sdk/gateway";
import { APICallError, RetryError } from "ai";
import { safeErrorFields } from "../safe-error-fields";

export type QuestionErrorKind =
  | "not_configured"
  | "busy"
  | "timeout"
  | "failed";

// What a failure means for the person waiting, from its kind:
// - unavailable: question writing can't work until someone fixes it
//   (no credentials, a 401/403, an unknown model, or a 402: AI Gateway is
//   out of credits). Retrying soon won't help, so the copy says to come
//   back later and offers no Try again.
// - transient: a timeout, a busy or overloaded model, or a one-off
//   failure (400, other 5xx, a network error). Trying again may work.
// A provider outage shows up as one of these too: a 529 or overloaded
// reply is busy, a 5xx is failed (one request can't tell an outage from a
// one-off error).
export type QuestionErrorClass = "unavailable" | "transient";

export const QUESTION_ERROR_CLASSES: Record<QuestionErrorKind, QuestionErrorClass> = {
  not_configured: "unavailable",
  busy: "transient",
  timeout: "transient",
  failed: "transient",
};

export function questionErrorClass(kind: QuestionErrorKind): QuestionErrorClass {
  return QUESTION_ERROR_CLASSES[kind];
}

// Teacher-facing (a set, a sample, or a replacement question).
export const QUESTION_ERROR_MESSAGES: Record<QuestionErrorKind, string> = {
  not_configured: "Question writing isn’t available right now. Trying again soon won’t help, so please check back later.",
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

// After the SDK's retries, it throws a RetryError holding every try's
// error; the last one decides.
function unwrapRetry(error: unknown): unknown {
  return RetryError.isInstance(error) ? error.lastError : error;
}

// The error and its causes, nearest first. The gateway wraps whatever
// fetch threw (an abort, a network error) in a GatewayResponseError, so
// the real reason is often a cause or two down.
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current != null && chain.length < 6 && !chain.includes(current)) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

// The overall deadline's TimeoutError, a per-request timeout (also a
// TimeoutError, from AbortSignal.timeout in the adapter's fetch), a plain
// abort, or the gateway's own client-side timeout error.
function isAbortLike(error: unknown): boolean {
  if (!(error instanceof Error) && !(typeof DOMException === "function" && error instanceof DOMException)) {
    return false;
  }
  const { name } = error as { name: string };
  return (
    name === "TimeoutError" ||
    name === "AbortError" ||
    name === "ResponseAborted" ||
    name === "GatewayTimeoutError"
  );
}

// generateText re-throws the gateway's 401 (wrapGatewayError in ai) as a
// new error with no status or cause: outside production, a plain Error
// named "GatewayAuthenticationError"; in production, an AISDKError named
// "GatewayError" (no real gateway error class has that exact name).
function isWrappedAuthError(error: unknown): boolean {
  if (!(error instanceof Error) || GatewayError.isInstance(error)) return false;
  return error.name === "GatewayAuthenticationError" || error.name === "GatewayError";
}

function statusOf(error: unknown): number | undefined {
  if (GatewayError.isInstance(error)) return error.statusCode;
  if (APICallError.isInstance(error)) return error.statusCode;
  return undefined;
}

// Anthropic's overloaded_error, if the gateway passed its body through.
function isOverloaded(error: unknown): boolean {
  return causeChain(error).some((e) => {
    if (!APICallError.isInstance(e)) return false;
    const data = e.data as { error?: { type?: unknown } } | undefined;
    return data?.error?.type === "overloaded_error";
  });
}

// Most specific first. An abort anywhere in the chain is the deadline or a
// per-request timeout (the only aborts we start), so it's a timeout even
// when the gateway wrapped it as a 500.
export function questionErrorKind(error: unknown): QuestionErrorKind {
  if (error instanceof QuestionWriterError) return error.kind;
  const last = unwrapRetry(error);
  if (causeChain(last).some(isAbortLike)) return "timeout";
  if (
    isWrappedAuthError(last) ||
    GatewayAuthenticationError.isInstance(last) ||
    GatewayForbiddenError.isInstance(last) ||
    // A model id the gateway doesn't know: AI_MODEL is wrong.
    GatewayModelNotFoundError.isInstance(last) ||
    GatewayNotFoundError.isInstance(last)
  ) {
    return "not_configured";
  }
  if (GatewayRateLimitError.isInstance(last)) return "busy";
  const status = statusOf(last);
  // 402: the gateway account is out of credits. That's our setup, not the
  // student's, so it's not set up (and the try is given back).
  if (status === 401 || status === 402 || status === 403 || status === 404) return "not_configured";
  if (status === 429 || status === 529 || isOverloaded(last)) return "busy";
  // 400, any other 5xx, a network error (the gateway reports it as a 500),
  // and anything unknown.
  return "failed";
}

// Fields that are safe to log: no reading text, prompts, answers, names,
// keys, or tokens. The error itself goes through safeErrorFields (names,
// codes, causes, timedOut; never a message: a gateway message can quote
// the request), and after the SDK's retries, the last try's too.
export function questionErrorLogFields(error: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = { kind: questionErrorKind(error), ...safeErrorFields(error) };
  if (error instanceof QuestionWriterError) fields.reason = error.reason;
  if (RetryError.isInstance(error)) {
    fields.tries = error.errors.length;
    fields.retryReason = error.reason;
  }
  const last = unwrapRetry(error);
  if (last !== error) fields.last = safeErrorFields(last);
  if (GatewayError.isInstance(last)) {
    fields.status = last.statusCode;
    fields.type = last.type;
    if (last.generationId) fields.generationId = last.generationId;
  } else if (APICallError.isInstance(last)) {
    fields.status = last.statusCode;
  }
  return fields;
}

// The loud extra line when the gateway says the account is out of credits
// (402): every question write and effort check fails until someone adds
// credits, and the usual "write failed" line doesn't say why.
export const AI_OUT_OF_CREDITS_LOG =
  "AI Gateway is out of credits (402). Question writing and the effort check " +
  "fail until credits are added (Vercel dashboard, AI Gateway). Failed calls " +
  "are given back and don't use up anyone's limits.";

// Logs a failed model call: `message` with the safe fields (from
// questionErrorLogFields or effortErrorLogFields, plus ids), and the
// out-of-credits line too on a 402. Never the text, prompts, or names.
export function logModelError(
  message: string,
  fields: Record<string, unknown>,
  logError: (message: string, fields: Record<string, unknown>) => void = console.error,
): void {
  logError(message, fields);
  if (fields.status === 402) logError(AI_OUT_OF_CREDITS_LOG, { where: message, ...fields });
}
