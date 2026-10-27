import { isProduction, type Env } from "./env";
import { JOIN_DISABLED_MESSAGE, logJoinBlockedConfig, type JoinBlockedConfig } from "./validate-join";

// The bot check on joining a class: a Cloudflare Turnstile token from the
// join form, verified server side with Turnstile's siteverify API. Pure
// (the env, fetch, and loggers are injectable), so tests cover every
// outcome without a network.
//
// On or off (botCheckConfig). Production is isProduction (env.ts), the
// same test as JOIN_IP_HASH_SECRET (client-ip.ts):
// - TURNSTILE_DISABLED=1 (exactly "1"): off, keys or not. Outside
//   production that's all. In production it is the one way to run
//   without the check, an explicit opt-out, and every join logs a
//   console.warn saying so (each time the check runs, not once per
//   process: a serverless deploy has many short processes, so "once"
//   would be easy to miss).
// - Both NEXT_PUBLIC_TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY set: on.
//   The join form shows the widget and every join needs a good token.
// - In production, either key missing (or both): "misconfigured". Every
//   join is refused with JOIN_DISABLED_MESSAGE ("Joining isn’t working
//   right now", as when JOIN_IP_HASH_SECRET is missing) and one
//   console.error tagged "join_blocked_config" names the missing
//   variable(s), never a value. The join action checks this up front
//   (join-config.ts); verifyJoinBotCheck refuses the same way as a
//   backstop. Like JOIN_IP_HASH_SECRET, a production deploy fails closed
//   instead of quietly running without it.
// - Outside production, neither key: off (local dev, tests, the DB
//   checks), with no widget and no network call; joins rely on the rate
//   limits alone. Cloudflare's public test keys (see .env.example) turn it
//   on locally when you want to see the widget.
// - Outside production, only one key: misconfigured too, so a typo
//   doesn't quietly turn the check off while you're testing it.
//
// When on, it fails CLOSED: a missing or overlong token, a network error, a
// timeout (TURNSTILE_TIMEOUT_MS), a non-2xx reply, a reply that isn't JSON,
// success: false, a token made for another action, or one solved on a
// hostname we don't expect (see expectedHostnames) all refuse the join
// with kid-friendly copy. Nothing is stored.
//
// Order in the join action (src/app/join/actions.ts): form validation (no
// network), then the server setup check (join-config.ts), then this check,
// then the rate limits, then the insert. A
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

// Cloudflare's published test secret keys (always passes, always fails,
// token already spent). Not secrets. Their replies carry an empty action
// and the hostname "example.com", so the action and hostname checks are
// skipped for them, and only for them.
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
export const TURNSTILE_TEST_SECRET_KEYS: readonly string[] = [
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
];

// No token in the form: the widget hadn't finished, or didn't load.
export const BOT_CHECK_MISSING_MESSAGE = "Finish the check above the button, then try again.";
// Turnstile said no, or we couldn't reach it.
export const BOT_CHECK_FAILED_MESSAGE = "We couldn’t check that you’re a person. Try again in a moment.";

export type BotCheckConfig =
  // "no_keys": outside production with neither key. "disabled":
  // TURNSTILE_DISABLED=1; `warn` is set in production.
  | { status: "off"; reason: "no_keys" | "disabled"; warn?: string }
  | { status: "on"; siteKey: string; secretKey: string; hostnames: string[] | null }
  // Names the missing variable(s), never a value.
  | { status: "misconfigured"; missing: string[] };

const SITE_KEY_VAR = "NEXT_PUBLIC_TURNSTILE_SITE_KEY";
const SECRET_KEY_VAR = "TURNSTILE_SECRET_KEY";

export const BOT_CHECK_DISABLED_WARNING =
  "Join bot check is OFF in production because TURNSTILE_DISABLED=1. Joins rely on the rate limits alone. Remove TURNSTILE_DISABLED to turn it back on.";

export function botCheckMisconfiguredError(missing: string[]): string {
  return `Join bot check is misconfigured: ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set. Every join is refused until both Turnstile keys are set (or TURNSTILE_DISABLED=1 to opt out on purpose).`;
}

// "unpack.example.org" from "https://unpack.example.org/" or a bare host.
function hostOf(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return "";
  }
}

// The hostnames a token may have been solved on, or null to skip the
// check:
// - TURNSTILE_EXPECTED_HOSTNAMES (comma-separated) when set, anywhere.
// - Else, in production, the deploy's own hostnames from Vercel
//   (VERCEL_PROJECT_PRODUCTION_URL, the production domain;
//   VERCEL_BRANCH_URL, the branch's stable URL, which preview links
//   usually point at; and VERCEL_URL, this deployment's URL), when Vercel
//   sets them. Vercel builds previews with NODE_ENV=production too, so
//   this covers Preview. A custom preview domain still needs
//   TURNSTILE_EXPECTED_HOSTNAMES set for the Preview environment.
// - Else null: off Vercel with no list, or outside production with no
//   list, the hostname isn't checked (the action and the secret still
//   are).
// Always null with a Cloudflare test secret, whose replies say
// "example.com".
export function expectedHostnames(env: Env, secretKey: string): string[] | null {
  if (TURNSTILE_TEST_SECRET_KEYS.includes(secretKey)) return null;
  const listed = (env.TURNSTILE_EXPECTED_HOSTNAMES ?? "").split(",").map(hostOf).filter(Boolean);
  if (listed.length > 0) return listed;
  if (!isProduction(env)) return null;
  const vercel = [env.VERCEL_PROJECT_PRODUCTION_URL, env.VERCEL_BRANCH_URL, env.VERCEL_URL].map((v) => hostOf(v ?? "")).filter(Boolean);
  return vercel.length > 0 ? [...new Set(vercel)] : null;
}

export function botCheckConfig(env: Env = process.env): BotCheckConfig {
  const production = isProduction(env);
  if (env.TURNSTILE_DISABLED === "1") {
    return production
      ? { status: "off", reason: "disabled", warn: BOT_CHECK_DISABLED_WARNING }
      : { status: "off", reason: "disabled" };
  }
  const siteKey = env[SITE_KEY_VAR]?.trim() ?? "";
  const secretKey = env[SECRET_KEY_VAR]?.trim() ?? "";
  if (siteKey && secretKey) {
    return { status: "on", siteKey, secretKey, hostnames: expectedHostnames(env, secretKey) };
  }
  if (!siteKey && !secretKey && !production) return { status: "off", reason: "no_keys" };
  const missing = [...(siteKey ? [] : [SITE_KEY_VAR]), ...(secretKey ? [] : [SECRET_KEY_VAR])];
  return { status: "misconfigured", missing };
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
  // A refused token: safe fields only (the reason and Turnstile's error
  // codes), never the token or the secret. Not called for
  // "misconfigured", which goes to logError instead.
  onFailure?: (fields: Record<string, unknown>) => void;
  // The loud server log for a misconfigured deploy (default
  // console.error, called as logJoinBlockedConfig does: the
  // "join_blocked_config" tag, then the missing names and the message)
  // and the production opt-out's warning (default console.warn).
  // Variable names only, never values.
  logError?: (tag: string, fields: JoinBlockedConfig) => void;
  logWarn?: (message: string) => void;
};

// What the student sees. Misconfigured gets JOIN_DISABLED_MESSAGE, as a
// missing JOIN_IP_HASH_SECRET does: it's not the student's doing.
export function botCheckMessage(reason: JoinBotCheckFailure): string {
  if (reason === "missing_token") return BOT_CHECK_MISSING_MESSAGE;
  if (reason === "misconfigured") return JOIN_DISABLED_MESSAGE;
  return BOT_CHECK_FAILED_MESSAGE;
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
  if (config.status === "off") {
    if (config.warn) (deps.logWarn ?? console.warn)(config.warn);
    return { ok: true, skipped: true };
  }
  if (config.status === "misconfigured") {
    logJoinBlockedConfig({ missing: config.missing, message: botCheckMisconfiguredError(config.missing) }, deps.logError);
    return { ok: false, reason: "misconfigured" };
  }

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

  const { success, action, hostname } = (reply ?? {}) as { success?: unknown; action?: unknown; hostname?: unknown };
  const errorCodes = (reply as { "error-codes"?: unknown } | null)?.["error-codes"];
  if (success !== true) return fail("rejected", { errorCodes: Array.isArray(errorCodes) ? errorCodes : [] });
  // A real token carries the action the widget set. Only a test secret's
  // reply may have an empty or missing one.
  const testSecret = TURNSTILE_TEST_SECRET_KEYS.includes(config.secretKey);
  const actionOk = action === TURNSTILE_ACTION || (testSecret && (action === undefined || action === ""));
  if (!actionOk) return fail("rejected", { errorCodes: ["action-mismatch"] });
  if (config.hostnames && !(typeof hostname === "string" && config.hostnames.includes(hostname.toLowerCase()))) {
    // The reply's hostname is our own domain (or a stranger's), not
    // personal data, so it's safe to log.
    return fail("rejected", { errorCodes: ["hostname-mismatch"], hostname: typeof hostname === "string" ? hostname : null });
  }
  return { ok: true, skipped: false };
}
