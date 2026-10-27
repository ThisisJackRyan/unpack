"use server";

import { redirect } from "next/navigation";
import type { RoleFormState } from "@/components/role-form-state";
import { requireArea, setAccountRole } from "@/lib/account";
import { AGE_REQUIRED_MESSAGE, homeFor, parseRoleChoice, ROLE_SAVE_FAILED_MESSAGE, type SetRoleOutcome } from "@/lib/account-role";

// The first-run choice. Only for an account with no role yet (requireArea
// sends any other home), and the save itself only matches while no role
// is set, so two tabs can't both choose (see setRoleStatements).
export async function chooseRoleAction(_prev: RoleFormState, formData: FormData): Promise<RoleFormState> {
  const account = await requireArea("welcome");
  const role = formData.get("role");
  const choice = parseRoleChoice({ role, ageConfirmed: formData.get("ageConfirmed") }, account.ageConfirmedAt !== null);
  const kept = typeof role === "string" ? role : undefined;
  if (!choice.ok) return { errors: choice.errors, role: kept };

  let outcome: SetRoleOutcome;
  try {
    outcome = await setAccountRole(account.id, choice.role, choice.confirmAge, true);
  } catch (error) {
    const { name, code } = error as { name?: unknown; code?: unknown };
    console.error("chooseRoleAction: save failed", { name, code });
    return { errors: { form: ROLE_SAVE_FAILED_MESSAGE }, role: kept };
  }
  if (outcome.status === "saved" || outcome.status === "already_chosen") redirect(homeFor(outcome.role));
  if (outcome.status === "age_required") return { errors: { age: AGE_REQUIRED_MESSAGE }, role: kept };
  return { errors: { form: ROLE_SAVE_FAILED_MESSAGE }, role: kept };
}
