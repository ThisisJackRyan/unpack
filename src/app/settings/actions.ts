"use server";

import { redirect } from "next/navigation";
import type { RoleFormState } from "@/components/role-form-state";
import { requireArea, setAccountRole } from "@/lib/account";
import {
  AGE_REQUIRED_MESSAGE,
  BIRTH_MONTH_FIELD,
  BIRTH_YEAR_FIELD,
  homeFor,
  needsSwitchConfirm,
  parseSettingsRoleChoice,
  ROLE_SAVE_FAILED_MESSAGE,
  SWITCH_CONFIRM_VALUE,
  type SetRoleOutcome,
} from "@/lib/account-role";
import { readAgeGate, setAgeGate } from "@/lib/age-gate";
import { safeErrorFields } from "@/lib/safe-error-fields";

// Switches the account's role. Keeps every row (classes and self-learner
// readings alike); only the home changes. Choosing the current role again
// is a no-op that lands on the same home. The first switch to self-learner
// needs the age confirmation, in the same statement. A teacher's switch to
// self-learner also needs the confirm (their classes stay live); without
// it, nothing is saved and the form shows the warning. The age gate
// cookie is checked here too (not only on the page), so an account that
// picked teacher on /welcome after an under-13 answer can't switch to
// self-learner from this device. The month and year are only passed to
// parseSettingsRoleChoice: never kept, logged, or sent back.
export async function switchRoleAction(_prev: RoleFormState, formData: FormData): Promise<RoleFormState> {
  const account = await requireArea("settings");
  const role = formData.get("role");
  const confirmSwitch = formData.get("confirmSwitch");
  const choice = parseSettingsRoleChoice(
    { role, birthMonth: formData.get(BIRTH_MONTH_FIELD), birthYear: formData.get(BIRTH_YEAR_FIELD), confirmSwitch },
    { role: account.role, ageConfirmed: account.ageConfirmedAt !== null, ageGated: await readAgeGate(), now: new Date() },
  );
  const kept = typeof role === "string" ? role : undefined;
  // Once confirmed, a retry after another error doesn't ask again.
  const confirmed =
    needsSwitchConfirm(account.role, kept) && confirmSwitch === SWITCH_CONFIRM_VALUE ? { switchConfirm: "confirmed" as const } : {};
  if (!choice.ok) {
    if ("confirmSwitch" in choice) return { role: kept, switchConfirm: "ask" };
    if ("ageGate" in choice) {
      if (choice.ageGate === "set") await setAgeGate();
      return { role: kept, ageGate: true };
    }
    return { errors: choice.errors, role: kept, ...confirmed };
  }

  let outcome: SetRoleOutcome;
  try {
    outcome = await setAccountRole(account.id, choice.role, choice.confirmAge, false);
  } catch (error) {
    console.error("switchRoleAction: save failed", safeErrorFields(error));
    return { errors: { form: ROLE_SAVE_FAILED_MESSAGE }, role: kept, ...confirmed };
  }
  if (outcome.status === "saved") redirect(homeFor(outcome.role));
  if (outcome.status === "age_required") return { errors: { age: AGE_REQUIRED_MESSAGE }, role: kept, ...confirmed };
  return { errors: { form: ROLE_SAVE_FAILED_MESSAGE }, role: kept, ...confirmed };
}
