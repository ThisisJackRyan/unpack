// The bot check on joining a class: a Cloudflare Turnstile token from the
// join form, verified server side with Turnstile's siteverify API. Pure
// (the env and fetch are injectable), so tests cover every outcome without
// a network.
//
// On or off:
// - On when BOTH NEXT_PUBLIC_TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are
//   set. The join form shows the widget and every join needs a good token.
// - Off when neither is set (local dev, tests, the DB checks): no widget and
//   no network call; joins rely on the rate limits alone.
// - Only one of them set is a broken deploy, not "off": every join is
//   refused (fail closed) and the log names the missing variable, so a typo
//   can't quietly turn the check off. The same rule as JOIN_IP_HASH_SECRET.
//
// When on, it fails CLOSED: a missing or overlong token, a network error, a
// timeout (TURNSTILE_TIMEOUT_MS), a non-2xx reply, a reply that isn't JSON,
// success: false, or a token made for another action all refuse the join
// with kid-friendly copy. Nothing is stored.
//
// Order in the join action (src/app/join/actions.ts): form validation (no
// network), then this check, then the rate limits, then the insert. A
// refused bot check never reaches the rate limits, so a bot that can't
// pass Turnstile can't use up a real code's 100 tries per 10 minutes or a
// school's shared IP budget. Each Turnstile token is single use, so every
// counted try had to pass a fresh check.
//
// Privacy: only the secret and the token are sent. The student's IP
// address (siteverify's optional remoteip) is not, and no name is.

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
// The form field Turnstile fills in (and the name the widget gives its
// hidden input).
export const TURNSTILE_RESPONSE_FIELD = "cf-turnstile-response";
// Set on the widget and checked in the reply, so a token made for another
// form on a site sharing the key can't be replayed here.
export const TURNSTILE_ACTION = "join";
export const TURNSTILE_TIMEOUT_MS = 5_000;
// Turnstile tokens are at most 2048 characters; anything longer is junk
// and is refused without a network call.
export const TURNSTILE_TOKEN_MAX_LENGTH = 2048;

// No token in the form: the widget hadn't finished, or didn't load.
export const BOT_CHECK_MISSING_MESSAGE = "Finish the check above the button, then try again.";
// Turnstile said no, or we couldn't reach it.
export const BOT_CHECK_FAILED_MESSAGE = "We couldn’t check that you’re a person. Try again in a moment.";

type Env = Partial<Record<string, string | undefined>>;

export type BotCheckConfig =
  | { status: "off" }
  | { status: "on"; siteKey: string; secretKey: string }
  // Exactly one key is set: names the missing variable, never a value.
  | { status: "misconfigured"; missing: string };

export function botCheckConfig(env: Env = process.env): BotCheckConfig {
  const siteKey = env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() ?? "";
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim() ?? "";
  if (siteKey && secretKey) return { status: "on", siteKey, secretKey };
  if (!siteKey && !secretKey) return { status: "off" };
  return { status: "misconfigured", missing: siteKey ? "TURNSTILE_SECRET_KEY" : "NEXT_PUBLIC_TURNSTILE_SITE_KEY" };
}

// The site key for the join form's widget, or null when the form should
// show none (off). A misconfigured deploy shows none either: its joins are
// refused anyway.
export function botCheckSiteKey(env: Env = process.env): string | null {
  const config = botCheckConfig(env);
  return config.status === "on" ? config.siteKey : null;
}

export type JoinBotCheckInput = {
  // The form's TURNSTILE_RESPONSE_FIELD value (raw FormData value).
  token: unknown;
};

export type JoinBotCheckFailure = "missing_token" | "rejected" | "unavailable" | "misconfigured";

export type JoinBotCheckResult = { ok: true; skipped: boolean } | { ok: false; reason: JoinBotCheckFailure };

export type JoinBotCheckDeps = {
  env?: Env;
  fetch?: typeof fetch;
  timeoutMs?: number;
  // Safe fields only: the reason and Turnstile's error codes, never the
  // token or the secret.
  onFailure?: (fields: Record<string, unknown>) => void;
};

export function botCheckMessage(reason: JoinBotCheckFailure): string {
  return reason === "missing_token" ? BOT_CHECK_MISSING_MESSAGE : BOT_CHECK_FAILED_MESSAGE;
}

export async function verifyJoinBotCheck(
  input: JoinBotCheckInput,
  deps: JoinBotCheckDeps = {},
): Promise<JoinBotCheckResult> {
  const config = botCheckConfig(deps.env ?? process.env);
  const fail = (reason: JoinBotCheckFailure, extra: Record<string, unknown> = {}): JoinBotCheckResult => {
    deps.onFailure?.({ reason, ...extra });
    return { ok: false, reason };
  };
  if (config.status === "off") return { ok: true, skipped: true };
  if (config.status === "misconfigured") return fail("misconfigured", { missing: config.missing });

  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (!token) return fail("missing_token");
  if (token.length > TURNSTILE_TOKEN_MAX_LENGTH) return fail("rejected", { errorCodes: ["token-too-long"] });

  const body = new URLSearchParams({ secret: config.secretKey, response: token });
  let reply: unknown;
  try {
    const response = await (deps.fetch ?? fetch)(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(deps.timeoutMs ?? TURNSTILE_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) return fail("unavailable", { httpStatus: response.status });
    reply = await response.json();
  } catch (error) {
    // Network error, timeout (TimeoutError), or a body that isn't JSON.
    return fail("unavailable", { error: (error as { name?: unknown } | null)?.name });
  }

  const { success, action } = (reply ?? {}) as { success?: unknown; action?: unknown };
  const errorCodes = (reply as { "error-codes"?: unknown } | null)?.["error-codes"];
  if (success !== true) return fail("rejected", { errorCodes: Array.isArray(errorCodes) ? errorCodes : [] });
  // Cloudflare's test keys reply with an empty action; a real token
  // carries the one the widget set.
  if (typeof action === "string" && action !== "" && action !== TURNSTILE_ACTION) {
    return fail("rejected", { errorCodes: ["action-mismatch"] });
  }
  return { ok: true, skipped: false };
}
