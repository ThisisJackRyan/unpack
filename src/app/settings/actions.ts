"use server";

import { redirect } from "next/navigation";
import type { RoleFormState } from "@/components/role-form-state";
import { requireArea, setAccountRole } from "@/lib/account";
import {
  AGE_REQUIRED_MESSAGE,
  homeFor,
  needsSwitchConfirm,
  parseSettingsRoleChoice,
  ROLE_SAVE_FAILED_MESSAGE,
  SWITCH_CONFIRM_VALUE,
  type SetRoleOutcome,
} from "@/lib/account-role";

// Switches the account's role. Keeps every row (classes and self-learner
// readings alike); only the home changes. Choosing the current role again
// is a no-op that lands on the same home. The first switch to self-learner
// needs the age confirmation, in the same statement. A teacher's switch to
// self-learner also needs the confirm (their classes stay live); without
// it, nothing is saved and the form shows the warning.
export async function switchRoleAction(_prev: RoleFormState, formData: FormData): Promise<RoleFormState> {
  const account = await requireArea("settings");
  const role = formData.get("role");
  const confirmSwitch = formData.get("confirmSwitch");
  const choice = parseSettingsRoleChoice(
    { role, ageConfirmed: formData.get("ageConfirmed"), confirmSwitch },
    { role: account.role, ageConfirmed: account.ageConfirmedAt !== null },
  );
  const kept = typeof role === "string" ? role : undefined;
  // Once confirmed, a retry after another error doesn't ask again.
  const confirmed =
    needsSwitchConfirm(account.role, kept) && confirmSwitch === SWITCH_CONFIRM_VALUE ? { switchConfirm: "confirmed" as const } : {};
  if (!choice.ok) {
    if ("confirmSwitch" in choice) return { role: kept, switchConfirm: "ask" };
    return { errors: choice.errors, role: kept, ...confirmed };
  }

  let outcome: SetRoleOutcome;
  try {
    outcome = await setAccountRole(account.id, choice.role, choice.confirmAge, false);
  } catch (error) {
    const { name, code } = error as { name?: unknown; code?: unknown };
    console.error("switchRoleAction: save failed", { name, code });
    return { errors: { form: ROLE_SAVE_FAILED_MESSAGE }, role: kept, ...confirmed };
  }
  if (outcome.status === "saved") redirect(homeFor(outcome.role));
  if (outcome.status === "age_required") return { errors: { age: AGE_REQUIRED_MESSAGE }, role: kept, ...confirmed };
  return { errors: { form: ROLE_SAVE_FAILED_MESSAGE }, role: kept, ...confirmed };
}
