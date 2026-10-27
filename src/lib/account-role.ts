// The account role: which home a signed-in Clerk account uses. Pure logic
// and SQL text, so tests cover every rule; the server-only side (the
// session, the redirects) is src/lib/account.ts.
//
// Rules:
// - A new account has no role and goes to /welcome to choose: "I’m a
//   teacher" or "I’m reading for myself". Accounts from before self-learner
//   mode were backfilled to teacher (migration 0008).
// - Self-learner needs the age confirmation ("I’m 13 or older", COPPA). We
//   store only when it was confirmed (teachers.age_confirmed_at), never a
//   birthdate. The role and the timestamp are written by ONE statement
//   that refuses self_learner without a confirmation (now or earlier), and
//   the teachers_self_learner_age_check constraint is the backstop.
//   Teachers don't need it.
// - Switching in /settings keeps every row: it only changes which home the
//   account sees. Classes stay with the account while it is a self-learner
//   (and come back when it switches back); self-learner readings stay while
//   it is a teacher. Nothing is deleted.
// - Every page, action, and route guards its area with roleRedirect, on
//   the server.

import type { Statement } from "./link-rate-limit";

export const ACCOUNT_ROLES = ["teacher", "self_learner"] as const;

export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export function isAccountRole(value: unknown): value is AccountRole {
  return typeof value === "string" && (ACCOUNT_ROLES as readonly string[]).includes(value);
}

// The checkbox's value when ticked.
export const AGE_CONFIRMED_VALUE = "yes";

export const ROLE_REQUIRED_MESSAGE = "Choose one to keep going.";
export const AGE_REQUIRED_MESSAGE = "Please confirm you’re 13 or older to read for yourself.";
export const ROLE_SAVE_FAILED_MESSAGE = "We couldn’t save that. Please try again.";

// Where each role lives. No role yet: the first-run choice.
export function homeFor(role: AccountRole | null): string {
  if (role === "teacher") return "/teacher";
  if (role === "self_learner") return "/learn";
  return "/welcome";
}

// The guarded areas: /teacher/** (classes), /learn/** (self-learner),
// /welcome (the first-run choice), and /settings (any role).
export type Area = "teacher" | "learn" | "welcome" | "settings";

// Where to send an account that may not be in `area`, or null when it may.
// - No role: only /welcome; everything else goes there.
// - /welcome once a role is chosen: the role's home (the choice is made
//   once; later changes are in /settings).
// - /teacher for a self-learner goes to /learn, and /learn for a teacher
//   goes to /teacher.
export function roleRedirect(area: Area, role: AccountRole | null): string | null {
  if (role === null) return area === "welcome" ? null : "/welcome";
  if (area === "welcome") return homeFor(role);
  if (area === "settings") return null;
  const allowed: AccountRole = area === "teacher" ? "teacher" : "self_learner";
  return role === allowed ? null : homeFor(role);
}

export type RoleChoiceErrors = { role?: string; age?: string };

export type RoleChoice =
  | { ok: true; role: AccountRole; confirmAge: boolean }
  | { ok: false; errors: RoleChoiceErrors };

// Reads the choice form (raw FormData values). `ageAlreadyConfirmed`: the
// account confirmed before (a switch back to self-learner doesn't ask
// again). The age box only matters for self-learner.
export function parseRoleChoice(
  input: { role: unknown; ageConfirmed: unknown },
  ageAlreadyConfirmed = false,
): RoleChoice {
  if (!isAccountRole(input.role)) return { ok: false, errors: { role: ROLE_REQUIRED_MESSAGE } };
  const role = input.role;
  if (role === "teacher") return { ok: true, role, confirmAge: false };
  const ticked = input.ageConfirmed === AGE_CONFIRMED_VALUE;
  if (!ticked && !ageAlreadyConfirmed) return { ok: false, errors: { age: AGE_REQUIRED_MESSAGE } };
  return { ok: true, role, confirmAge: ticked };
}

// One transaction:
// 1. Set the role, and the age confirmation the first time it is given, in
//    one UPDATE (the row lock serializes concurrent changes). It matches
//    only when:
//    - firstRun ($4): the account has no role yet, so two tabs racing on
//      /welcome save exactly one choice; and
//    - for self_learner: the age is confirmed now ($3) or was before.
//    Setting the role it already has is a harmless no-op (idempotent).
// 2. Say where things stand (a fresh snapshot after step 1).
// $1 account id, $2 role, $3 age confirmed now, $4 first run.
export function setRoleStatements(
  accountId: string,
  role: AccountRole,
  confirmAge: boolean,
  firstRun: boolean,
): Statement[] {
  const params = [accountId, role, confirmAge, firstRun];
  return [
    {
      text: `update teachers set role = $2::account_role,
  age_confirmed_at = case
    when $2::account_role = 'self_learner' and age_confirmed_at is null and $3::boolean then now()
    else age_confirmed_at
  end
where id = $1::uuid
  and (not $4::boolean or role is null)
  and ($2::account_role = 'teacher' or age_confirmed_at is not null or $3::boolean)
returning role`,
      params,
    },
    {
      text: `select role, age_confirmed_at is not null as age_confirmed from teachers where id = $1::uuid`,
      params: [accountId],
    },
  ];
}

export type SetRoleOutcome =
  | { status: "saved"; role: AccountRole }
  // First run, but a role was already chosen (another tab): go home.
  | { status: "already_chosen"; role: AccountRole }
  | { status: "age_required" }
  | { status: "not_found" };

export function setRoleOutcome(
  results: Record<string, unknown>[][],
  role: AccountRole,
  firstRun: boolean,
): SetRoleOutcome {
  if ((results[0]?.length ?? 0) > 0) return { status: "saved", role };
  const row = results[1]?.[0];
  if (!row) return { status: "not_found" };
  if (role === "self_learner" && row.age_confirmed !== true) return { status: "age_required" };
  // First run, and another request chose first (or the same, twice).
  if (firstRun && isAccountRole(row.role)) return { status: "already_chosen", role: row.role };
  return { status: "not_found" };
}

export function roleLabel(role: AccountRole): string {
  return role === "teacher" ? "Teacher" : "Reading for myself";
}
