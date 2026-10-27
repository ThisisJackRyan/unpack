// The account role: which home a signed-in Clerk account uses. Pure logic
// and SQL text, so tests cover every rule; the server-only side (the
// session, the redirects) is src/lib/account.ts.
//
// Rules:
// - A new account has no role and goes to /welcome to choose: "I’m a
//   teacher" or "I’m reading for myself". Accounts from before self-learner
//   mode were backfilled to teacher (migration 0008).
// - Self-learner needs the neutral age screen (COPPA; birth month and
//   year, checked on the server by checkAgeScreen in age-screen.ts). We
//   store only when 13+ was confirmed (teachers.age_confirmed_at), never
//   the month or year. The role and the timestamp are written by ONE
//   statement that refuses self_learner without a confirmation (now or
//   earlier), and the teachers_self_learner_age_check constraint is the
//   backstop. Teachers don't get the screen (unchanged from PR 13).
// - An under-13 answer sets the age gate cookie (age-screen.ts). While it
//   is on the device, self-learner is refused without asking again, on
//   /welcome and in /settings alike, so picking teacher first and then
//   switching doesn't get around it. An account that confirmed earlier
//   isn't asked, so the cookie doesn't change anything for it.
// - Switching in /settings keeps every row: it only changes which home the
//   account sees. Classes stay with the account while it is a self-learner
//   (and come back when it switches back); self-learner readings stay while
//   it is a teacher. Nothing is deleted.
// - A teacher switching to self-learner in /settings confirms it first
//   (SWITCH_CONFIRM_VALUE): their classes and join codes stay live while
//   they read for themselves. The action refuses the switch without it.
// - Every page, action, and route guards its area with roleRedirect, on
//   the server.

import { AGE_SCREEN_ERROR, checkAgeScreen } from "./age-screen";
import type { Statement } from "./link-rate-limit";

export const ACCOUNT_ROLES = ["teacher", "self_learner"] as const;

export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export function isAccountRole(value: unknown): value is AccountRole {
  return typeof value === "string" && (ACCOUNT_ROLES as readonly string[]).includes(value);
}

// The age screen's two selects.
export const BIRTH_MONTH_FIELD = "birthMonth";
export const BIRTH_YEAR_FIELD = "birthYear";

export const ROLE_REQUIRED_MESSAGE = "Choose one to keep going.";
export const AGE_REQUIRED_MESSAGE = AGE_SCREEN_ERROR;
export const ROLE_SAVE_FAILED_MESSAGE = "We couldn’t save that. Please try again.";

// Where each role lives. No role yet: the first-run choice.
export function homeFor(role: AccountRole | null): string {
  if (role === "teacher") return "/teacher";
  if (role === "self_learner") return "/learn";
  return "/welcome";
}

// The /settings link back to the account's home, named for what is there:
// a teacher's classes or a self-learner's reading (no role yet: the
// first-run choice; /settings sends that account to /welcome anyway).
export function settingsBackLink(role: AccountRole | null): { href: string; label: string } {
  if (role === "teacher") return { href: homeFor(role), label: "Back to your classes" };
  if (role === "self_learner") return { href: homeFor(role), label: "Back to your reading" };
  return { href: homeFor(role), label: "Back home" };
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
  | { ok: false; errors: RoleChoiceErrors }
  // Self-learner, but the age screen said under 13 (now: set the cookie)
  // or did before on this device (the cookie): show the class note.
  | { ok: false; ageGate: "set" | "kept" };

// What the account and the device already say about the age screen.
export type AgeContext = {
  // The account confirmed before (a switch back to self-learner doesn't
  // ask again).
  ageConfirmed: boolean;
  // The age gate cookie is on this device.
  ageGated: boolean;
  now: Date;
};

// Reads the choice form (raw FormData values). The age answer only
// matters for self-learner, and is never read when the account confirmed
// before or the cookie is set.
export function parseRoleChoice(input: { role: unknown; birthMonth: unknown; birthYear: unknown }, ctx: AgeContext): RoleChoice {
  if (!isAccountRole(input.role)) return { ok: false, errors: { role: ROLE_REQUIRED_MESSAGE } };
  const role = input.role;
  if (role === "teacher" || ctx.ageConfirmed) return { ok: true, role, confirmAge: false };
  if (ctx.ageGated) return { ok: false, ageGate: "kept" };
  const result = checkAgeScreen({ month: input.birthMonth, year: input.birthYear }, ctx.now);
  if (result === "invalid") return { ok: false, errors: { age: AGE_REQUIRED_MESSAGE } };
  if (result === "under") return { ok: false, ageGate: "set" };
  return { ok: true, role, confirmAge: true };
}

// The confirm button's value on a teacher's switch to self-learner.
export const SWITCH_CONFIRM_VALUE = "yes";

// A teacher's switch to self-learner needs the confirm; any other change
// (or no change) doesn't.
export function needsSwitchConfirm(current: AccountRole | null, chosen: string | null | undefined): boolean {
  return current === "teacher" && chosen === "self_learner";
}

export type SettingsRoleChoice =
  | RoleChoice
  // A teacher chose self-learner without the confirm: show the warning.
  | { ok: false; confirmSwitch: true };

// The /settings form: parseRoleChoice, then the switch confirm. The age
// screen is checked first, so a confirmed switch that still needs it
// doesn't ask to confirm again, and an under-13 answer is never saved.
export function parseSettingsRoleChoice(
  input: { role: unknown; birthMonth: unknown; birthYear: unknown; confirmSwitch: unknown },
  account: { role: AccountRole | null } & AgeContext,
): SettingsRoleChoice {
  const choice = parseRoleChoice(input, account);
  if (!choice.ok) return choice;
  if (needsSwitchConfirm(account.role, choice.role) && input.confirmSwitch !== SWITCH_CONFIRM_VALUE) {
    return { ok: false, confirmSwitch: true };
  }
  return choice;
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
