import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { QuestionWriterError, type QuestionModel } from "./questions";
import {
  AI_MAX_RETRIES,
  AI_TIMEOUT_MS,
  DEFAULT_ANTHROPIC_MODEL,
} from "./settings";

// Server-only: the Anthropic client, built on first use from
// ANTHROPIC_API_KEY and ANTHROPIC_MODEL. Nothing here runs at import, so
// `next build` works without a real key.

let cached: { key: string; client: Anthropic } | undefined;

export function isQuestionWritingConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

// Throws QuestionWriterError("not_configured") when the key is missing,
// which the caller shows as a friendly message instead of crashing.
export function getQuestionModel(): QuestionModel {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    throw new QuestionWriterError("not_configured", "ANTHROPIC_API_KEY is not set");
  }
  if (cached?.key !== key) {
    cached = {
      key,
      // The key is passed explicitly so the SDK never falls back to other
      // credential sources on the server.
      client: new Anthropic({
        apiKey: key,
        timeout: AI_TIMEOUT_MS,
        maxRetries: AI_MAX_RETRIES,
      }),
    };
  }
  const client = cached.client;
  return {
    model: process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL,
    create: (params, options) => client.messages.create(params, options),
  };
}

// The effort check uses the same client, key, and model as question
// writing. A missing key throws the same not_configured error.
export const getEffortCheckModel = getQuestionModel;
