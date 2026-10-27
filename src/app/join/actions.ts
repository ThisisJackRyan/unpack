"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIpFromHeaders, hashJoinIp } from "@/lib/client-ip";
import { botCheckMessage, TURNSTILE_RESPONSE_FIELD, verifyJoinBotCheck } from "@/lib/join-bot-check";
import { joinConfigBlock } from "@/lib/join-config";
import { joinClass } from "@/lib/student-join";
import { joinOutcomeErrors, type JoinOutcome } from "@/lib/student-join-core";
import { setStudentSessionCookie } from "@/lib/student-session";
import {
  JOIN_DISABLED_MESSAGE,
  JOIN_FAILED_MESSAGE,
  logJoinBlockedConfig,
  validateJoin,
} from "@/lib/validate-join";
import type { JoinState } from "./form-state";

// Joins a class and starts the student's session. Joining while already in
// a class (the form is still on /join for that) replaces the cookie: this
// browser then belongs to the new student. The old student row and its
// work stay, for the teacher.
export async function joinClassAction(_prev: JoinState, formData: FormData): Promise<JoinState> {
  const result = validateJoin({
    code: formData.get("code"),
    firstName: formData.get("firstName"),
    lastInitials: formData.get("lastInitials"),
  });
  if (!result.ok) return { errors: result.errors, values: result.values };
  const { data, values } = result;

  // Server setup first, before any network call or database work: with a
  // Turnstile key missing, or JOIN_IP_HASH_SECRET missing or unusable in
  // production, no join can work, so the student is told joining is
  // turned off and one "join_blocked_config" error names the missing
  // variable(s), never a value (see join-config.ts).
  const blocked = joinConfigBlock();
  if (blocked) {
    logJoinBlockedConfig(blocked);
    return { errors: { form: JOIN_DISABLED_MESSAGE }, values };
  }

  // The bot check comes before the rate limits (see join-bot-check.ts): a
  // refused check isn't counted, so a bot can't use up a code's tries. Off
  // (no keys outside production, or TURNSTILE_DISABLED=1) it passes with no
  // network call. Misconfigured was refused above; it refuses that too, as
  // a backstop. It never throws.
  const bot = await verifyJoinBotCheck(
    { token: formData.get(TURNSTILE_RESPONSE_FIELD) },
    { onFailure: (fields) => console.error("joinClassAction: bot check refused", fields) },
  );
  if (!bot.ok) return { errors: { form: botCheckMessage(bot.reason) }, values };

  const requestHeaders = await headers();
  let outcome: JoinOutcome;
  try {
    // Throws in production when JOIN_IP_HASH_SECRET is missing or short.
    // The setup check above already refused that; this is a backstop, so
    // the join still fails closed (with the generic message below).
    const ipHash = hashJoinIp(clientIpFromHeaders((name) => requestHeaders.get(name)));
    outcome = await joinClass(data, ipHash);
  } catch (error) {
    // Name, code, and message only: a Postgres error's detail can echo the
    // row, including the student's name.
    const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
    console.error("joinClassAction: join failed", { name, code, message });
    return { errors: { form: JOIN_FAILED_MESSAGE }, values };
  }

  if (outcome.status !== "joined") return { errors: joinOutcomeErrors(outcome), values };

  await setStudentSessionCookie(outcome.token);
  // redirect() throws, so it stays outside the try above.
  redirect("/c");
}
