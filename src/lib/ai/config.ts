// How the app reaches the model: Vercel AI Gateway credentials and the
// model id, read from the environment. Pure (the env is passed in), so
// tests cover every case. Never returns or logs a key or token value.
//
// Credentials, in the order the gateway provider itself uses them
// (@ai-sdk/gateway getGatewayAuthToken: an API key, if set, always wins,
// even an invalid one; otherwise OIDC via @vercel/oidc):
// 1. AI_GATEWAY_API_KEY: an AI Gateway API key. For local dev, or a host
//    other than Vercel.
// 2. OIDC: VERCEL_OIDC_TOKEN in the environment (what `vercel env pull`
//    writes for local dev; it expires after 12 hours), or, on a Vercel
//    deployment (VERCEL=1), the token Vercel sends with each request in
//    the x-vercel-oidc-token header. On Vercel this needs no env at all.
// With neither, question writing and the effort check are not set up.

import { DEFAULT_AI_MODEL } from "./settings";

type Env = Record<string, string | undefined>;

export type AiCredentials =
  | { method: "api-key"; apiKey: string }
  // env: VERCEL_OIDC_TOKEN is set. vercel: running on Vercel, where the
  // token arrives with each request (the provider reads it there).
  | { method: "oidc"; source: "env" | "vercel" }
  | { method: "none" };

export function resolveAiCredentials(env: Env): AiCredentials {
  const apiKey = env.AI_GATEWAY_API_KEY?.trim();
  if (apiKey) return { method: "api-key", apiKey };
  if (env.VERCEL_OIDC_TOKEN?.trim()) return { method: "oidc", source: "env" };
  if (env.VERCEL === "1") return { method: "oidc", source: "vercel" };
  return { method: "none" };
}

// For the server log when nothing is set. Names the setup, never a value.
export const AI_NOT_CONFIGURED_LOG =
  "AI Gateway is not set up: no AI_GATEWAY_API_KEY and no Vercel OIDC token " +
  "(VERCEL_OIDC_TOKEN unset and not running on Vercel). Question writing and " +
  "the effort check are off. On Vercel, enable AI Gateway for the project; " +
  "locally, run `vercel env pull` or set AI_GATEWAY_API_KEY.";

// A bare Anthropic id (claude-sonnet-5-5) in the gateway's naming
// (anthropic/claude-sonnet-5.5): creator prefix, and the version's dash
// as a dot. A dated id (claude-sonnet-4-5-20250929) drops the date, which
// gateway ids don't carry. An id with a slash is already a gateway id. An
// id in another shape just gets the prefix; if the gateway doesn't know
// it, the call fails as not set up and the server log says so.
export function toGatewayModelId(id: string): string {
  const trimmed = id.trim();
  if (trimmed.includes("/")) return trimmed;
  const match = /^(claude-[a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(trimmed);
  if (match) {
    const [, family, major, minor] = match;
    return `anthropic/${family}-${major}${minor ? `.${minor}` : ""}`;
  }
  return `anthropic/${trimmed}`;
}

// AI_MODEL, else the legacy ANTHROPIC_MODEL (still read so an existing
// deploy keeps its model), else the default. Both go through
// toGatewayModelId, so a bare Anthropic id works in either.
export function resolveModelId(env: Env): string {
  const model = env.AI_MODEL?.trim() || env.ANTHROPIC_MODEL?.trim();
  return model ? toGatewayModelId(model) : DEFAULT_AI_MODEL;
}
