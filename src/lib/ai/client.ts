import "server-only";
import { AI_NOT_CONFIGURED_LOG, resolveAiCredentials, resolveModelId } from "./config";
import { QuestionWriterError } from "./errors";
import { createGatewayCall } from "./gateway-adapter";
import type { ModelCall, QuestionModel } from "./model";
import { AI_MAX_RETRIES, AI_TIMEOUT_MS } from "./settings";

// Server-only: the model behind Vercel AI Gateway, built on first use from
// the environment (see config.ts for credentials and the model id).
// Nothing here runs at import, so `next build` works without credentials.

let cached: { key: string; call: ModelCall } | undefined;

// True when an API key or an OIDC token is available. Logs loudly when
// not (naming what's missing, never a value), since every caller then
// shows "isn't set up yet" and nothing else would say why.
export function isQuestionWritingConfigured(): boolean {
  if (resolveAiCredentials(process.env).method !== "none") return true;
  console.error(AI_NOT_CONFIGURED_LOG);
  return false;
}

// Throws QuestionWriterError("not_configured") with no credentials, which
// the caller shows as a friendly message instead of crashing. Called per
// write, so a changed key is picked up.
export function getQuestionModel(): QuestionModel {
  const credentials = resolveAiCredentials(process.env);
  if (credentials.method === "none") {
    console.error(AI_NOT_CONFIGURED_LOG);
    throw new QuestionWriterError("not_configured", "no AI Gateway API key or OIDC token");
  }
  const apiKey = credentials.method === "api-key" ? credentials.apiKey : undefined;
  // The cache key is the key itself or "oidc"; it is never logged.
  const key = apiKey ?? "oidc";
  if (cached?.key !== key) {
    cached = {
      key,
      call: createGatewayCall({ apiKey, timeoutMs: AI_TIMEOUT_MS, maxRetries: AI_MAX_RETRIES }),
    };
  }
  return { model: resolveModelId(process.env), create: cached.call };
}

// The effort check uses the same gateway, credentials, and model as
// question writing. No credentials throws the same not_configured error.
export const getEffortCheckModel = getQuestionModel;
