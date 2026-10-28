// An under-13 answer on /welcome deletes the account right away (COPPA:
// once we know a user is under 13 we don't keep their personal
// information). Pure flow and SQL text over injected dependencies, so
// tests cover every step; the /welcome action (src/app/welcome/actions.ts,
// through welcome-core.ts) passes the real ones.
//
// Only for an account with NO role yet. An account that already has a
// role (teacher or self-learner) is never deleted here: the local delete
// refuses it in the same transaction, and then Clerk isn't called either.
//
// Order: the local delete first, then Clerk's deleteUser.
// 1. Local (deleteRolelessAccountStatements): the same delete as the
//    user.deleted webhook (deleteTeacherStatements in clerk-webhook.ts),
//    with every step limited to a row whose role is still null. It takes
//    the same account lock, locks the row, deletes what hangs off it, lists
//    the id's hash on deleted_clerk_users, and deletes the row, in one
//    transaction. Done first so nothing depends on the webhook's timing:
//    the moment it commits, the name and email are gone and the hash list
//    refuses a first visit or a late user.created (deleted-accounts.ts).
// 2. Clerk (users.deleteUser): removes the account itself, and its
//    sessions. Clerk then sends user.deleted, and the webhook's delete
//    finds no row: already_gone, a harmless no-op (the hash insert is ON
//    CONFLICT DO NOTHING). Run at the same moment, the account lock puts
//    the two deletes one after the other.
//
// Failures (fail safe: the account must not survive):
// - The local delete throws: Clerk is still called, so the webhook's
//   delete (which Svix retries for days) removes the row.
// - Clerk throws: tried once more. If that fails too, the row is already
//   gone and the hash listed, so the account can't get a row back: a sign
//   in later only reaches the deleted-account refusal in account.ts, which
//   calls deleteUser again (retryClerkDelete). A 404 from Clerk means it
//   is already gone and counts as done.
// - Either way the caller still sets the cookie and signs the user out.
//
// Logs: one fixed tag (UNDER_13_DELETE_TAG) with fixed outcome words and,
// for a failure, the error's name and code. Never the Clerk id, the email,
// the name, or the month or year (those are never passed in at all).

import { accountLockStatement, hashClerkUserId, pruneDeletedStatement } from "./deleted-accounts";
import type { Statement } from "./link-rate-limit";

export const UNDER_13_DELETE_TAG = "under13_account_delete";

// The webhook's delete (deleteTeacherStatements), limited to a row with
// no role: steps 2 to 7 match nothing when the row has one, so a role
// holder keeps everything and its hash is not listed. Locked (account
// lock, then the row) before anything is read, so a role saved by
// another tab either committed first (and is seen here) or waits until
// the row is gone (and its update then matches nothing).
// $1 the Clerk id; the list insert takes the hash as $2.
export function deleteRolelessAccountStatements(clerkUserId: string): Statement[] {
  const params = [clerkUserId];
  const roleless = `select id from teachers where clerk_user_id = $1::text and role is null`;
  return [
    accountLockStatement(clerkUserId),
    { text: `select id, role from teachers where clerk_user_id = $1::text for update`, params },
    { text: `delete from classes\nwhere teacher_id in (${roleless})`, params },
    { text: `delete from self_readings\nwhere account_id in (${roleless})`, params },
    {
      text: `insert into deleted_clerk_users (clerk_user_hash)
select $2::text
where not exists (select 1 from teachers where clerk_user_id = $1::text and role is not null)
on conflict (clerk_user_hash) do nothing`,
      params: [clerkUserId, hashClerkUserId(clerkUserId)],
    },
    pruneDeletedStatement(),
    { text: `delete from teachers where clerk_user_id = $1::text and role is null returning id`, params },
  ];
}

// deleted: the row was removed. already_gone: there was no row (it is
// listed anyway). has_role: refused, nothing changed.
export type RolelessDeleteOutcome = "deleted" | "already_gone" | "has_role";

export function rolelessDeleteOutcome(results: Record<string, unknown>[][]): RolelessDeleteOutcome {
  const row = results[1]?.[0];
  if (row && row.role !== null && row.role !== undefined) return "has_role";
  return (results.at(-1)?.length ?? 0) > 0 ? "deleted" : "already_gone";
}

export type Under13DeleteDeps = {
  // Runs deleteRolelessAccountStatements as one transaction.
  deleteLocal: (clerkUserId: string) => Promise<RolelessDeleteOutcome>;
  // clerkClient().users.deleteUser.
  deleteClerkUser: (clerkUserId: string) => Promise<unknown>;
  // Safe fields only (see the top of this file).
  log: (level: "info" | "error", message: string, fields: Record<string, unknown>) => void;
};

// deleted: the account is gone, or as gone as it can be right now (see
// Failures above); sign the user out. has_role: another request saved a
// role first; nothing was deleted.
export type Under13DeleteResult = "deleted" | "has_role";

function errorFields(error: unknown): { name?: unknown; code?: unknown; status?: unknown } {
  const { name, code, status } = (error ?? {}) as { name?: unknown; code?: unknown; status?: unknown };
  return { name, code, status };
}

// Clerk says the account doesn't exist (already deleted).
function isNotFound(error: unknown): boolean {
  return errorFields(error).status === 404;
}

// deleteUser, tried twice; a 404 counts as done.
async function deleteInClerk(clerkUserId: string, deps: Under13DeleteDeps): Promise<{ ok: true } | { ok: false; error: unknown }> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await deps.deleteClerkUser(clerkUserId);
      return { ok: true };
    } catch (error) {
      if (isNotFound(error)) return { ok: true };
      last = error;
    }
  }
  return { ok: false, error: last };
}

export async function deleteUnder13Account(clerkUserId: string, deps: Under13DeleteDeps): Promise<Under13DeleteResult> {
  let local: RolelessDeleteOutcome | "failed";
  let localError: unknown;
  try {
    local = await deps.deleteLocal(clerkUserId);
  } catch (error) {
    local = "failed";
    localError = error;
  }
  if (local === "has_role") {
    deps.log("info", UNDER_13_DELETE_TAG, { local, clerk: "skipped" });
    return "has_role";
  }
  const clerk = await deleteInClerk(clerkUserId, deps);
  const failed = local === "failed" || !clerk.ok;
  deps.log(failed ? "error" : "info", UNDER_13_DELETE_TAG, {
    local,
    clerk: clerk.ok ? "deleted" : "failed",
    ...(local === "failed" ? { localError: errorFields(localError) } : {}),
    ...(!clerk.ok ? { clerkError: errorFields(clerk.error) } : {}),
  });
  return "deleted";
}

// The deleted-account refusal (account.ts): a signed-in Clerk account
// whose id is on the deleted list should not exist in Clerk any more, so
// this is an under-13 delete whose Clerk call failed. Try it again. Never
// throws; logs the same tag with no id.
export async function retryClerkDelete(clerkUserId: string, deps: Pick<Under13DeleteDeps, "deleteClerkUser" | "log">): Promise<void> {
  try {
    await deps.deleteClerkUser(clerkUserId);
    deps.log("info", UNDER_13_DELETE_TAG, { retry: "deleted" });
  } catch (error) {
    if (isNotFound(error)) return;
    deps.log("error", UNDER_13_DELETE_TAG, { retry: "failed", clerkError: errorFields(error) });
  }
}
