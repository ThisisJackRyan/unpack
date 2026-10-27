"use server";

import { redirect } from "next/navigation";
import type { RoleFormState } from "@/components/role-form-state";
import { requireArea, setAccountRole } from "@/lib/account";
import {
  AGE_REQUIRED_MESSAGE,
  BIRTH_MONTH_FIELD,
  BIRTH_YEAR_FIELD,
  homeFor,
  parseRoleChoice,
  ROLE_SAVE_FAILED_MESSAGE,
  type SetRoleOutcome,
} from "@/lib/account-role";
import { readAgeGate, setAgeGate } from "@/lib/age-gate";

// The first-run choice. Only for an account with no role yet (requireArea
// sends any other home), and the save itself only matches while no role
// is set, so two tabs can't both choose (see setRoleStatements). The age
// screen's month and year are only passed to parseRoleChoice: never kept,
// logged, or sent back.
export async function chooseRoleAction(_prev: RoleFormState, formData: FormData): Promise<RoleFormState> {
  const account = await requireArea("welcome");
  const role = formData.get("role");
  const choice = parseRoleChoice(
    { role, birthMonth: formData.get(BIRTH_MONTH_FIELD), birthYear: formData.get(BIRTH_YEAR_FIELD) },
    { ageConfirmed: account.ageConfirmedAt !== null, ageGated: await readAgeGate(), now: new Date() },
  );
  const kept = typeof role === "string" ? role : undefined;
  if (!choice.ok) {
    if ("ageGate" in choice) {
      if (choice.ageGate === "set") await setAgeGate();
      return { role: kept, ageGate: true };
    }
    return { errors: choice.errors, role: kept };
  }

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
