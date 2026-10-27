// Clerk webhook: keeps the teachers row (every Clerk account's row,
// teacher or self-learner) in step with the Clerk account. Pure flow over an injected verifier and executor, so tests run
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
// - user.created: upsert the teachers row by clerk_user_id (name from
//   first and last name, else the username; email the primary address,
//   else the first one, the same as the lazy creation in teacher.ts).
//   ON CONFLICT (clerk_user_id) DO UPDATE, so it is race-safe with that
//   lazy creation (a first visit and the webhook at the same moment end
//   with one row), and a redelivery is harmless. It never sets a role:
//   a new account chooses on /welcome (see account-role.ts), and the
//   upsert leaves an existing row's role alone.
// - user.updated: update only (update teachers ... where clerk_user_id),
//   never an insert. Svix doesn't promise delivery order, so a late
//   user.updated can arrive after user.deleted; an upsert would bring the
//   deleted teacher's row (and email) back. No row is a 200 ("no_teacher"):
//   a teacher who never visited gets their row from the lazy creation.
//   A user with no email address at all is skipped on either event (email
//   is required); the lazy creation refuses such a user too.
// - user.deleted: deletes the account's classes, then its self-learner
//   readings, then the teachers row, in one transaction
//   (deleteTeacherStatements). The classes cascade to their readings,
//   students, and all student work; the self-learner readings to their
//   questions, tries, answers, and effort checks; the account row then to
//   its own logs (see docs/privacy.md). The Clerk
//   account is gone, so they can never sign in to see it again; keeping
//   the children's data would only keep it longer than needed. A repeat
//   (or a user who never visited) deletes nothing and is still a 200.
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

export function updateTeacherStatement(profile: TeacherProfile): Statement {
  return {
    text: `update teachers set name = $2::text, email = $3::text
where clerk_user_id = $1::text
returning id`,
    params: [profile.clerkUserId, profile.name, profile.email],
  };
}

// Deletes an account (teacher or self-learner) and everything it owns, as
// one transaction. Not a single "delete from teachers": that statement
// would also run challenges.resolved_by's ON DELETE SET NULL on challenges
// the same statement is removing through their student or reading, and
// Postgres fails it with 23503 (the set null update re-checks the
// challenge's student_id foreign key after the student is gone). So:
//
// 1. Lock the account row, so a class or self-learner reading created
//    right now (insertClassIfAllowed and the self-learner create take the
//    same lock) either commits first and is deleted below, or waits and
//    then finds no account.
// 2. Delete their classes. That cascades to students and readings, and
//    under them questions, attempts, answers, challenges (resolved ones
//    too: resolved_by is only ever the class's own teacher), effort
//    checks, question generations, student question calls, and cap raises.
// 3. Delete their self-learner readings. That cascades to self_questions,
//    self_attempts, self_answers, and self_effort_checks (every self_*
//    foreign key is ON DELETE CASCADE, none SET NULL or RESTRICT). An
//    account that switched roles has both kinds, so both steps always run.
// 4. Delete the account row: what's left under it is the teacher's own
//    logs (link_fetch_attempts, question_generation_attempts, and any
//    reading_cap_raises left), and the cascade would reach any self_*
//    row step 3 missed. Applied when this returns the row.
//
// With no such account every statement matches nothing.
export function deleteTeacherStatements(clerkUserId: string): Statement[] {
  const params = [clerkUserId];
  return [
    { text: `select id from teachers where clerk_user_id = $1::text for update`, params },
    {
      text: `delete from classes
where teacher_id in (select id from teachers where clerk_user_id = $1::text)`,
      params,
    },
    {
      text: `delete from self_readings
where account_id in (select id from teachers where clerk_user_id = $1::text)`,
      params,
    },
    { text: `delete from teachers where clerk_user_id = $1::text returning id`, params },
  ];
}

// The account delete's own result: the last statement's rows.
export function deletedAccountRows(results: Record<string, unknown>[][]): number {
  return results.at(-1)?.length ?? 0;
}

export type WebhookOutcome =
  | "upserted"
  | "updated"
  | "no_teacher"
  | "deleted"
  | "already_gone"
  | "skipped_no_id"
  | "skipped_no_email"
  | "ignored";

export async function handleClerkEvent(event: ClerkEvent, execute: StatementExecutor): Promise<WebhookOutcome> {
  const data = (event.data ?? {}) as ClerkUserData;
  if (event.type === "user.created" || event.type === "user.updated") {
    const profile = teacherProfile(data);
    if ("missing" in profile) return profile.missing === "id" ? "skipped_no_id" : "skipped_no_email";
    if (event.type === "user.created") {
      await execute([upsertTeacherStatement(profile)]);
      return "upserted";
    }
    const [rows = []] = await execute([updateTeacherStatement(profile)]);
    return rows.length > 0 ? "updated" : "no_teacher";
  }
  if (event.type === "user.deleted") {
    if (typeof data.id !== "string" || !data.id) return "skipped_no_id";
    const results = await execute(deleteTeacherStatements(data.id));
    return deletedAccountRows(results) > 0 ? "deleted" : "already_gone";
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
