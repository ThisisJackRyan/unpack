// Clerk webhook: keeps the teachers row in step with the teacher's Clerk
// account. Pure flow over an injected verifier and executor, so tests run
// it with fakes (and the real verifier); the route is
// src/app/api/webhooks/clerk/route.ts.
//
// Verification: Clerk signs each delivery (Svix headers svix-id,
// svix-timestamp, svix-signature) with the endpoint's signing secret,
// CLERK_WEBHOOK_SIGNING_SECRET. No secret in the environment is our
// setup's fault: 500 and a loud server log, so Clerk retries and someone
// notices. A missing or bad signature is a 400 with no detail.
//
// Events:
// - user.created, user.updated: upsert the teachers row by
//   clerk_user_id (name from first and last name, else the username;
//   email the primary address, else the first one, the same as the lazy
//   creation in teacher.ts). ON CONFLICT (clerk_user_id) DO UPDATE, so it
//   is race-safe with that lazy creation (a first visit and the webhook
//   at the same moment end with one row), and a redelivery is harmless.
//   A user with no email address at all is skipped (email is required);
//   the lazy creation refuses such a user too.
// - user.deleted: deletes the teachers row, which cascades to their
//   classes, readings, students, and all student work (see
//   docs/privacy.md). The Clerk account is gone, so they can never sign
//   in to see it again; keeping the children's data would only keep it
//   longer than needed. A repeat (or a user who never visited) deletes
//   nothing and is still a 200.
// - Anything else: ignored with a 200, so Clerk doesn't retry it.
//
// Logs: only the event type and the outcome. Never a name, an email, or
// an id from the payload.

import type { Statement, StatementExecutor } from "./link-rate-limit";

export type ClerkEmail = { id?: string; email_address?: string };

export type ClerkUserData = {
  id?: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: ClerkEmail[];
  deleted?: boolean;
};

// The shape we read from a verified event; extra fields are ignored.
export type ClerkEvent = { type: string; data: unknown };

export type TeacherProfile = { clerkUserId: string; name: string | null; email: string };

// Name and email the way teacher.ts builds them from currentUser().
export function teacherProfile(data: ClerkUserData): TeacherProfile | { missing: "id" | "email" } {
  if (typeof data.id !== "string" || !data.id) return { missing: "id" };
  const emails = (data.email_addresses ?? []).filter(
    (e): e is { id?: string; email_address: string } => typeof e?.email_address === "string" && e.email_address.length > 0,
  );
  const email = (emails.find((e) => e.id && e.id === data.primary_email_address_id) ?? emails[0])?.email_address;
  if (!email) return { missing: "email" };
  const name = [data.first_name, data.last_name].filter(Boolean).join(" ") || data.username || null;
  return { clerkUserId: data.id, name, email };
}

export function upsertTeacherStatement(profile: TeacherProfile): Statement {
  return {
    text: `insert into teachers (clerk_user_id, name, email)
values ($1::text, $2::text, $3::text)
on conflict (clerk_user_id) do update set name = excluded.name, email = excluded.email
returning id`,
    params: [profile.clerkUserId, profile.name, profile.email],
  };
}

export function deleteTeacherStatement(clerkUserId: string): Statement {
  return {
    text: `delete from teachers where clerk_user_id = $1::text returning id`,
    params: [clerkUserId],
  };
}

export type WebhookOutcome = "upserted" | "deleted" | "already_gone" | "skipped_no_id" | "skipped_no_email" | "ignored";

export async function handleClerkEvent(event: ClerkEvent, execute: StatementExecutor): Promise<WebhookOutcome> {
  const data = (event.data ?? {}) as ClerkUserData;
  if (event.type === "user.created" || event.type === "user.updated") {
    const profile = teacherProfile(data);
    if ("missing" in profile) return profile.missing === "id" ? "skipped_no_id" : "skipped_no_email";
    await execute([upsertTeacherStatement(profile)]);
    return "upserted";
  }
  if (event.type === "user.deleted") {
    if (typeof data.id !== "string" || !data.id) return "skipped_no_id";
    const [rows = []] = await execute([deleteTeacherStatement(data.id)]);
    return rows.length > 0 ? "deleted" : "already_gone";
  }
  return "ignored";
}

export type WebhookDeps = {
  // CLERK_WEBHOOK_SIGNING_SECRET.
  secret: string | undefined;
  // Throws on a missing or bad signature.
  verify: (request: Request, secret: string) => Promise<ClerkEvent>;
  execute: StatementExecutor;
  // Safe fields only: event type, outcome, an error's name.
  log: (level: "info" | "error", message: string, fields?: Record<string, unknown>) => void;
};

function plain(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export async function handleClerkWebhookRequest(request: Request, deps: WebhookDeps): Promise<Response> {
  if (!deps.secret) {
    deps.log("error", "clerk webhook: CLERK_WEBHOOK_SIGNING_SECRET is not set; refusing every delivery");
    return plain(500, "Server misconfigured");
  }
  let event: ClerkEvent;
  try {
    event = await deps.verify(request, deps.secret);
  } catch {
    // No detail: the error message can describe what was wrong.
    return plain(400, "Bad request");
  }
  const type = typeof event?.type === "string" ? event.type : "unknown";
  try {
    const outcome = await handleClerkEvent(event, deps.execute);
    deps.log("info", "clerk webhook", { type, outcome });
    return plain(200, "OK");
  } catch (error) {
    // Name and code only: a Postgres error can echo the row (an email).
    const { name, code } = error as { name?: unknown; code?: unknown };
    deps.log("error", "clerk webhook: handling failed", { type, name, code });
    // 500, so Clerk retries the delivery.
    return plain(500, "Error");
  }
}
