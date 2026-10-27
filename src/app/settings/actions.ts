"use server";

import { redirect } from "next/navigation";
import type { RoleFormState } from "@/components/role-form-state";
import { requireArea, setAccountRole } from "@/lib/account";
import { AGE_REQUIRED_MESSAGE, homeFor, parseRoleChoice, ROLE_SAVE_FAILED_MESSAGE, type SetRoleOutcome } from "@/lib/account-role";

// Switches the account's role. Keeps every row (classes and self-learner
// readings alike); only the home changes. Choosing the current role again
// is a no-op that lands on the same home. The first switch to self-learner
// needs the age confirmation, in the same statement.
export async function switchRoleAction(_prev: RoleFormState, formData: FormData): Promise<RoleFormState> {
  const account = await requireArea("settings");
  const role = formData.get("role");
  const choice = parseRoleChoice({ role, ageConfirmed: formData.get("ageConfirmed") }, account.ageConfirmedAt !== null);
  const kept = typeof role === "string" ? role : undefined;
  if (!choice.ok) return { errors: choice.errors, role: kept };

  let outcome: SetRoleOutcome;
  try {
    outcome = await setAccountRole(account.id, choice.role, choice.confirmAge, false);
  } catch (error) {
    const { name, code } = error as { name?: unknown; code?: unknown };
    console.error("switchRoleAction: save failed", { name, code });
    return { errors: { form: ROLE_SAVE_FAILED_MESSAGE }, role: kept };
  }
  if (outcome.status === "saved") redirect(homeFor(outcome.role));
  if (outcome.status === "age_required") return { errors: { age: AGE_REQUIRED_MESSAGE }, role: kept };
  return { errors: { form: ROLE_SAVE_FAILED_MESSAGE }, role: kept };
}
