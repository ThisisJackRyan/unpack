import { joinIpHashSecretProblem } from "./client-ip";
import type { Env } from "./env";
import { botCheckConfig, botCheckMisconfiguredError } from "./join-bot-check";
import type { JoinBlockedConfig } from "./validate-join";

// Is the server set up to take joins? Checked by the join action after
// form validation and before the bot check's network call, the rate
// limits, or any other database work. Null when it is; otherwise the
// missing variable names (never a value) and the existing explanations,
// for one logJoinBlockedConfig line, and the student sees
// JOIN_DISABLED_MESSAGE. Blocks when:
// - the Turnstile keys are misconfigured (see botCheckConfig), or
// - in production (isProduction, env.ts), JOIN_IP_HASH_SECRET is
//   missing, short, or the example or dev-only value (see
//   joinIpHashSecretProblem).
// Both at once give one block naming all of them.
export function joinConfigBlock(env: Env = process.env): JoinBlockedConfig | null {
  const blocks: JoinBlockedConfig[] = [];
  const bot = botCheckConfig(env);
  if (bot.status === "misconfigured") blocks.push({ missing: bot.missing, message: botCheckMisconfiguredError(bot.missing) });
  const ip = joinIpHashSecretProblem(env);
  if (ip) blocks.push(ip);
  if (blocks.length === 0) return null;
  return { missing: blocks.flatMap((b) => b.missing), message: blocks.map((b) => b.message).join(" ") };
}
