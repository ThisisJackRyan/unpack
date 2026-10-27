import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";
import { db, schema } from "@/db";
import type { Teacher } from "@/db/schema";
import { roleRedirect, setRoleOutcome, setRoleStatements, type AccountRole, type Area, type SetRoleOutcome } from "./account-role";
import type { StatementExecutor } from "./link-rate-limit";
import { neonExecutor } from "./neon-executor";

// Server-only: the signed-in Clerk account's row (the teachers table holds
// every account, teacher or self-learner) and the role guards every page
// and action calls. See account-role.ts for the rules.

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

  const user = await currentUser();
  if (!user) {
    return redirectToSignIn();
  }
  const email =
    user.primaryEmailAddress?.emailAddress ??
    user.emailAddresses[0]?.emailAddress;
  if (!email) {
    throw new Error(`Clerk user ${user.id} has no email address`);
  }
  const name =
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    user.username ||
    null;

  // Upsert, not insert: two first-visit requests can race to create the
  // row. The role is never set here: the account chooses on /welcome.
  const [account] = await db
    .insert(schema.teachers)
    .values({ clerkUserId: user.id, name, email })
    .onConflictDoUpdate({
      target: schema.teachers.clerkUserId,
      set: { name, email },
    })
    .returning();
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
