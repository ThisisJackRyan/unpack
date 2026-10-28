import type { RoleFormState } from "@/components/role-form-state";
import {
  AGE_REQUIRED_MESSAGE,
  BIRTH_MONTH_FIELD,
  BIRTH_YEAR_FIELD,
  homeFor,
  parseRoleChoice,
  ROLE_SAVE_FAILED_MESSAGE,
  type AccountRole,
  type SetRoleOutcome,
} from "@/lib/account-role";
import type { Under13DeleteResult } from "@/lib/under-13-account";

// Where an under-13 answer sends the user once the account is deleted:
// joining a class needs no account.
export const UNDER_13_EXIT_PATH = "/join";

// The /welcome action's steps, with everything that touches the outside
// world passed in, so tests can prove them (actions.ts is the thin wrapper
// that passes the real ones and redirects). Kept out of actions.ts because
// a "use server" file may only export async functions meant as actions.
export type ChooseRoleDeps = {
  // The signed-in account (requireArea("welcome"): no role yet).
  account: { id: string; clerkUserId: string; role: AccountRole | null; ageConfirmed: boolean };
  // The age gate cookie is on this device.
  ageGated: boolean;
  now: Date;
  setAgeGate: () => Promise<void>;
  setAccountRole: (accountId: string, role: AccountRole, confirmAge: boolean) => Promise<SetRoleOutcome>;
  // deleteUnder13Account with the real dependencies. Never throws.
  deleteUnder13: (clerkUserId: string) => Promise<Under13DeleteResult>;
  logError?: (message: string, fields: Record<string, unknown>) => void;
};

// Either the form's next state, or where to redirect.
export type ChooseRoleResult = { state: RoleFormState } | { redirect: string };

// The month and year are only passed to parseRoleChoice: never kept,
// logged, passed on, or sent back.
export async function chooseRoleCore(formData: FormData, deps: ChooseRoleDeps): Promise<ChooseRoleResult> {
  const logError = deps.logError ?? console.error;
  const { account } = deps;
  const role = formData.get("role");
  const choice = parseRoleChoice(
    { role, birthMonth: formData.get(BIRTH_MONTH_FIELD), birthYear: formData.get(BIRTH_YEAR_FIELD) },
    { role: account.role, ageConfirmed: account.ageConfirmed, ageGated: deps.ageGated, now: deps.now },
  );
  const kept = typeof role === "string" ? role : undefined;
  if (!choice.ok) {
    if ("ageGate" in choice) {
      if (choice.ageGate === "kept") return { state: { role: kept, ageGate: true } };
      // A fresh under-13 answer: the cookie first (it holds no id, so it
      // stays whatever happens next), then the account is deleted, and the
      // action redirects to UNDER_13_EXIT_PATH. Not a returned state: a
      // cookie set in an action makes Next render the current page again
      // in the same response, and /welcome can't load a deleted account.
      // A redirect renders the target instead. A role saved by another
      // tab first keeps the account (has_role): the class note only.
      await deps.setAgeGate();
      const deleted = await deps.deleteUnder13(account.clerkUserId);
      if (deleted === "has_role") return { state: { role: kept, ageGate: true } };
      return { redirect: UNDER_13_EXIT_PATH };
    }
    return { state: { errors: choice.errors, role: kept } };
  }

  let outcome: SetRoleOutcome;
  try {
    outcome = await deps.setAccountRole(account.id, choice.role, choice.confirmAge);
  } catch (error) {
    const { name, code } = error as { name?: unknown; code?: unknown };
    logError("chooseRoleAction: save failed", { name, code });
    return { state: { errors: { form: ROLE_SAVE_FAILED_MESSAGE }, role: kept } };
  }
  if (outcome.status === "saved" || outcome.status === "already_chosen") return { redirect: homeFor(outcome.role) };
  if (outcome.status === "age_required") return { state: { errors: { age: AGE_REQUIRED_MESSAGE }, role: kept } };
  return { state: { errors: { form: ROLE_SAVE_FAILED_MESSAGE }, role: kept } };
}

// The action's last step: redirect (Next's redirect() throws, so the
// action never returns) or hand back the form's state. Passed redirect so
// tests can check the path without Next.
export function finishChooseRole(result: ChooseRoleResult, redirect: (path: string) => never): RoleFormState {
  if ("redirect" in result) redirect(result.redirect);
  return result.state;
}
