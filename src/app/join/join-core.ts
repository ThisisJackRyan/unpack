import { clientIpFromHeaders, hashJoinIp, joinIpHashSecret } from "@/lib/client-ip";
import type { Env } from "@/lib/env";
import { botCheckMessage, TURNSTILE_RESPONSE_FIELD, type JoinBotCheckResult } from "@/lib/join-bot-check";
import { joinConfigBlock } from "@/lib/join-config";
import { joinLimitedMessage } from "@/lib/join-rate-limit";
import { withRetryAt, type RetryClock } from "@/lib/local-time";
import { safeErrorFields } from "@/lib/safe-error-fields";
import { joinOutcomeErrors, type JoinOutcome } from "@/lib/student-join-core";
import {
  JOIN_DISABLED_MESSAGE,
  JOIN_FAILED_MESSAGE,
  logJoinBlockedConfig,
  validateJoin,
  type JoinBlockedConfig,
  type JoinValues,
} from "@/lib/validate-join";
import type { JoinState } from "./form-state";

// The join action's steps, with everything that touches the outside world
// passed in, so tests can prove the order (actions.ts is the thin wrapper
// that passes the real ones, sets the cookie and redirects). Kept out of
// actions.ts because a "use server" file may only export async functions
// meant as actions.
export type JoinCoreDeps = {
  // For the setup check and the IP hash secret (default process.env).
  env?: Env;
  // The Turnstile check (verifyJoinBotCheck). Never throws.
  verifyBotCheck: (token: FormDataEntryValue | null) => Promise<JoinBotCheckResult>;
  // The request's headers (next/headers), for the client IP.
  requestHeaders: () => Promise<(name: string) => string | null>;
  // The rate limits and the insert (joinClass, student-join.ts).
  joinClass: (data: JoinValues, ipHash: string) => Promise<JoinOutcome>;
  // The visitor's clock, for the limit note's retry time.
  retryClock: () => Promise<RetryClock>;
  // Server logs (default console.error).
  logBlockedConfig?: (tag: string, fields: JoinBlockedConfig) => void;
  logError?: (message: string, fields: Record<string, unknown>) => void;
};

// Either the form's next state, or a join (the action then sets the
// session cookie from the token and redirects).
export type JoinCoreResult = { state: JoinState } | { joined: { token: string } };

export async function joinClassCore(formData: FormData, deps: JoinCoreDeps): Promise<JoinCoreResult> {
  const env = deps.env ?? process.env;
  const logError = deps.logError ?? console.error;
  const result = validateJoin({
    code: formData.get("code"),
    firstName: formData.get("firstName"),
    lastInitials: formData.get("lastInitials"),
  });
  if (!result.ok) return { state: { errors: result.errors, values: result.values } };
  const { data, values } = result;

  // Server setup first, before any network call or database work: with a
  // Turnstile key missing, or JOIN_IP_HASH_SECRET missing or unusable in
  // production, no join can work, so the student is told joining isn't
  // working right now and one "join_blocked_config" error names the missing
  // variable(s), never a value (see join-config.ts).
  const blocked = joinConfigBlock(env);
  if (blocked) {
    logJoinBlockedConfig(blocked, deps.logBlockedConfig);
    return { state: { errors: { form: JOIN_DISABLED_MESSAGE }, values } };
  }

  // The bot check comes before the rate limits (see join-bot-check.ts): a
  // refused check isn't counted, so a bot can't use up a code's tries. Off
  // (no keys outside production, or TURNSTILE_DISABLED=1) it passes with no
  // network call. Misconfigured was refused above; it refuses that too, as
  // a backstop. It never throws.
  const bot = await deps.verifyBotCheck(formData.get(TURNSTILE_RESPONSE_FIELD));
  if (!bot.ok) return { state: { errors: { form: botCheckMessage(bot.reason) }, values } };

  const header = await deps.requestHeaders();
  let outcome: JoinOutcome;
  try {
    // Throws in production when JOIN_IP_HASH_SECRET is missing or short.
    // The setup check above already refused that; this is a backstop, so
    // the join still fails closed (with the generic message below).
    const ipHash = hashJoinIp(clientIpFromHeaders(header), joinIpHashSecret(env));
    outcome = await deps.joinClass(data, ipHash);
  } catch (error) {
    // Safe fields only (safe-error-fields.ts): a query error's message can
    // echo the row, including the student's name.
    logError("joinClassAction: join failed", safeErrorFields(error));
    return { state: { errors: { form: JOIN_FAILED_MESSAGE }, values } };
  }

  if (outcome.status === "limited") {
    // A limit, not a mistake: an amber note with when to try again.
    return {
      state: {
        limit: withRetryAt(joinLimitedMessage(outcome.retry.by), outcome.retry.retryAt, await deps.retryClock()),
        values,
      },
    };
  }
  if (outcome.status !== "joined") return { state: { errors: joinOutcomeErrors(outcome), values } };
  return { joined: { token: outcome.token } };
}
