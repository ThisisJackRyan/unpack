import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";
import { db, schema } from "@/db";
import type { Teacher } from "@/db/schema";
import { clerkUserOrNull } from "./clerk-user";
import { ClerkUserNoEmailError } from "./clerk-user-errors";
import { ACCOUNT_DELETED_PATH, createAccountStatements } from "./deleted-accounts";
import { roleRedirect, setRoleOutcome, setRoleStatements, type AccountRole, type Area, type SetRoleOutcome } from "./account-role";
import type { StatementExecutor } from "./link-rate-limit";
import { neonExecutor } from "./neon-executor";
import { retryClerkDelete } from "./under-13-account";
import { under13DeleteDeps } from "./under-13-server";

// Server-only: the signed-in Clerk account's row (the teachers table holds
// every account, teacher or self-learner) and the role guards every page
// and action calls. See account-role.ts for the rules. A deleted account
// is never recreated: it is sent to ACCOUNT_DELETED_PATH.

export type Account = Teacher;

// The row for the signed-in Clerk user, creating it on first visit with
// name and email from Clerk (and no role). Cached per request so the
// layout, page, and actions share one lookup. Only a first visit calls the
// Clerk API (currentUser); later visits just read the row.
export const getOrCreateAccount = cache(async (): Promise<Account> => {
  const { userId, redirectToSignIn } = await auth();
  if (!userId) {
    return redirectToSignIn();
  }

  const [existing] = await db
    .select()
    .from(schema.teachers)
    .where(eq(schema.teachers.clerkUserId, userId))
    .limit(1);
  if (existing) return existing;

  // Gone in Clerk (a 404) is no user too: see clerk-user.ts.
  const user = await clerkUserOrNull(() => currentUser());
  if (!user) {
    return redirectToSignIn();
  }
  const email =
    user.primaryEmailAddress?.emailAddress ??
    user.emailAddresses[0]?.emailAddress;
  if (!email) {
    throw new ClerkUserNoEmailError();
  }
  const name =
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    user.username ||
    null;

  // Upsert, not insert: two first-visit requests can race to create the
  // row. The role is never set here: the account chooses on /welcome. A
  // deleted account (a session that outlived it) is refused in the same
  // statement, after the id's account lock (see deleted-accounts.ts): no
  // row is created, and the person sees a friendly page instead. A live
  // Clerk account on the deleted list is an under-13 delete whose Clerk
  // call failed (under-13-account.ts), so that is tried again first; on
  // success (or a 404) its hash is confirmed, so the list can prune it.
  const [, rows = []] = await neonExecutor(createAccountStatements(user.id, name, email));
  if (rows.length === 0) {
    await retryClerkDelete(user.id, under13DeleteDeps);
    redirect(ACCOUNT_DELETED_PATH);
  }
  const [account] = await db
    .select()
    .from(schema.teachers)
    .where(eq(schema.teachers.id, String(rows[0].id)))
    .limit(1);
  if (!account) redirect(ACCOUNT_DELETED_PATH);
  return account;
});

// The account, if it may be in `area`; otherwise a redirect to where it
// belongs (no role: /welcome; a self-learner in /teacher: /learn; a
// teacher in /learn: /teacher). Works in pages, layouts, and server
// actions (redirect() throws, so call it outside any try).
export async function requireArea(area: Area): Promise<Account> {
  const account = await getOrCreateAccount();
  const to = roleRedirect(area, account.role);
  if (to) redirect(to);
  return account;
}

export function requireSelfLearner(): Promise<Account> {
  return requireArea("learn");
}

// Sets the role (see setRoleStatements): firstRun from /welcome (only when
// no role is set yet), or a switch from /settings.
export async function setAccountRole(
  accountId: string,
  role: AccountRole,
  confirmAge: boolean,
  firstRun: boolean,
  execute: StatementExecutor = neonExecutor,
): Promise<SetRoleOutcome> {
  return setRoleOutcome(await execute(setRoleStatements(accountId, role, confirmAge, firstRun)), role, firstRun);
}
