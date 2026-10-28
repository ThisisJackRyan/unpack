"use server";

import { redirect } from "next/navigation";
import type { RoleFormState } from "@/components/role-form-state";
import { requireArea, setAccountRole } from "@/lib/account";
import { readAgeGate, setAgeGate } from "@/lib/age-gate";
import { deleteUnder13Account } from "@/lib/under-13-account";
import { under13DeleteDeps } from "@/lib/under-13-server";
import { chooseRoleCore, finishChooseRole } from "./welcome-core";

// The first-run choice. Only for an account with no role yet (requireArea
// sends any other home), and the save itself only matches while no role
// is set, so two tabs can't both choose (see setRoleStatements). An
// under-13 answer deletes the account and redirects to /join (Clerk's
// deleteUser has ended its sessions). The steps are in welcome-core.ts.
export async function chooseRoleAction(_prev: RoleFormState, formData: FormData): Promise<RoleFormState> {
  const account = await requireArea("welcome");
  const result = await chooseRoleCore(formData, {
    account: {
      id: account.id,
      clerkUserId: account.clerkUserId,
      role: account.role,
      ageConfirmed: account.ageConfirmedAt !== null,
    },
    ageGated: await readAgeGate(),
    now: new Date(),
    setAgeGate,
    setAccountRole: (accountId, role, confirmAge) => setAccountRole(accountId, role, confirmAge, true),
    deleteUnder13: (clerkUserId) => deleteUnder13Account(clerkUserId, under13DeleteDeps),
  });
  // redirect() throws, so it stays outside chooseRoleCore (finishChooseRole).
  return finishChooseRole(result, redirect);
}
