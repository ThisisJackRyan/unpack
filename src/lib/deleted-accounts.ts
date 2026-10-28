// The list of deleted Clerk accounts (deleted_clerk_users), so a deleted
// account stays deleted. Pure (hashing and SQL text), so tests cover it;
// the webhook (clerk-webhook.ts) writes it and the webhook and the
// first-visit creation (account.ts) read it.
//
// Why: Svix doesn't promise delivery order, and it retries for days, so a
// user.created can arrive after user.deleted; and a session can outlive
// its account for a moment. Either would otherwise create a fresh, empty
// row for an account the person deleted (with their name and email). The
// user.deleted cascade writes the id's hash in the same transaction, and
// user.created and the first visit insert only when the hash is not
// listed. All three first take the id's account lock (accountLockStatement),
// so they run one after another: a delete committed first always wins,
// and a create committed first is deleted. Without the lock a create
// could check the list before a concurrent delete commits it, while the
// delete can't yet see the create's uncommitted row, leaving a row behind.
//
// What is stored: only clerk_user_hash, SHA-256 of "deleted-clerk-user:"
// plus the Clerk user id, deleted_at, and clerk_deleted_at. Not keyed with
// a server secret
// (unlike the join IP hash, client-ip.ts): a Clerk id is a long random
// string, not something you can enumerate the way you can IPv4 addresses,
// so the hash can't be reversed by guessing, and with no key there is no
// new production secret to set and no rotation that would silently empty
// the list. Someone who already has the raw id (Clerk, or a copy of our
// old row) could confirm it was deleted, nothing more.
//
// Pending and confirmed: clerk_deleted_at is when Clerk's own delete was
// confirmed. The user.deleted webhook writes the row confirmed (Clerk
// sent it, so the account is gone there). The under-13 delete
// (under-13-account.ts) deletes our row first and writes the hash
// pending, then confirms it when Clerk's deleteUser succeeds or answers
// 404; the later webhook, or the retry on the account's next sign-in
// (account.ts), confirms it too. A confirm never un-confirms, and a
// pending write never touches a confirmed row. A pending row is a Clerk
// account that may still exist (with its email) after both deleteUser
// tries failed: it is never pruned, so that account can never get a row
// back, and ops can list these (pnpm ops:list-pending-clerk-deletes,
// scripts/list-pending-clerk-deletes.ts) and delete them in Clerk, whose
// user.deleted then confirms the row.
//
// Retention: a confirmed row is kept DELETED_ACCOUNT_RETENTION_DAYS (30)
// after clerk_deleted_at, then pruned by the next account delete (so a
// quiet stretch can keep a row longer, until the next delete). Counted
// from the confirmation, not deleted_at, so a row confirmed late still
// covers the Svix retries of the events Clerk sent around its delete.
// Clerk's retries end within a few days, and Clerk never reuses a user
// id, so 30 days is comfortably past any late delivery. See
// docs/privacy.md.

import { createHash } from "node:crypto";
import type { Statement } from "./link-rate-limit";

export const DELETED_ACCOUNT_RETENTION_DAYS = 30;

// The most expired rows one delete prunes, so each prune stays small.
export const DELETED_ACCOUNT_PRUNE_BATCH = 200;

// Advisory lock space for accountLockStatement (the join limits use 1 and
// 2, effort checks 3 and 4).
export const ACCOUNT_LOCK_SPACE = 5;

export function hashClerkUserId(clerkUserId: string): string {
  return createHash("sha256").update(`deleted-clerk-user:${clerkUserId}`, "utf8").digest("hex");
}

// SQL: the hash given as parameter $n is not on the list.
export function notDeletedSql(n: number): string {
  return `not exists (select 1 from deleted_clerk_users where clerk_user_hash = $${n}::text)`;
}

// The id's account lock, held to the end of the transaction. First in the
// account delete and in every create, so a create's insert runs (with a
// fresh snapshot) only after a concurrent delete has committed, or the
// delete's row lock waits for the create. By hash, never the raw id.
export function accountLockStatement(clerkUserId: string): Statement {
  return {
    text: "select pg_advisory_xact_lock($1::int, hashtext($2::text))",
    params: [ACCOUNT_LOCK_SPACE, hashClerkUserId(clerkUserId)],
  };
}

// Whether Clerk's own delete is confirmed when the hash is written (see
// the top of this file).
export type DeletedListState = "pending" | "confirmed";

// Lists the id. A repeat keeps the first deleted_at. "confirmed" also
// confirms a pending row (keeping an earlier confirmation); "pending"
// never touches an existing row, so it can't un-confirm one.
export function recordDeletedStatement(clerkUserId: string, state: DeletedListState): Statement {
  return {
    text:
      state === "confirmed"
        ? `insert into deleted_clerk_users (clerk_user_hash, clerk_deleted_at) values ($1::text, now())
on conflict (clerk_user_hash) do update
set clerk_deleted_at = coalesce(deleted_clerk_users.clerk_deleted_at, excluded.clerk_deleted_at)`
        : `insert into deleted_clerk_users (clerk_user_hash) values ($1::text)
on conflict (clerk_user_hash) do nothing`,
    params: [hashClerkUserId(clerkUserId)],
  };
}

// Clerk's delete succeeded (or Clerk answered 404): confirms the id's
// pending row. Update only: no row (the local delete failed) means the
// webhook's delete lists it, confirmed, when Clerk sends user.deleted.
export function confirmClerkDeletedStatement(clerkUserId: string): Statement {
  return {
    text: `update deleted_clerk_users set clerk_deleted_at = now()
where clerk_user_hash = $1::text and clerk_deleted_at is null`,
    params: [hashClerkUserId(clerkUserId)],
  };
}

// Deletes up to a batch of confirmed rows whose confirmation is older
// than the retention period. Pending rows (clerk_deleted_at null) are
// never pruned.
export function pruneDeletedStatement(): Statement {
  return {
    text: `delete from deleted_clerk_users
where clerk_user_hash in (
  select clerk_user_hash from deleted_clerk_users
  where clerk_deleted_at is not null
    and clerk_deleted_at < now() - make_interval(days => $1::int)
  order by clerk_deleted_at
  limit $2::int
  for update skip locked
)`,
    params: [DELETED_ACCOUNT_RETENTION_DAYS, DELETED_ACCOUNT_PRUNE_BATCH],
  };
}

// The ops listing (scripts/list-pending-clerk-deletes.ts): every pending
// row, oldest first. Hash and deleted_at only; nothing else is stored.
export function pendingClerkDeletesStatement(): Statement {
  return {
    text: `select clerk_user_hash, deleted_at from deleted_clerk_users
where clerk_deleted_at is null
order by deleted_at, clerk_user_hash`,
    params: [],
  };
}

export function isDeletedStatement(clerkUserId: string): Statement {
  return {
    text: `select exists (select 1 from deleted_clerk_users where clerk_user_hash = $1::text) as deleted`,
    params: [hashClerkUserId(clerkUserId)],
  };
}

// The first-visit creation (account.ts): insert or refresh the row, only
// while the id is not listed. No row back: the account was deleted. An
// existing row keeps its role (the update sets only name and email). Run
// it after accountLockStatement, in one batch (createAccountStatements).
export function createAccountStatement(clerkUserId: string, name: string | null, email: string): Statement {
  return {
    text: `insert into teachers (clerk_user_id, name, email)
select $1::text, $2::text, $3::text
where ${notDeletedSql(4)}
on conflict (clerk_user_id) do update set name = excluded.name, email = excluded.email
returning id`,
    params: [clerkUserId, name, email, hashClerkUserId(clerkUserId)],
  };
}

// The lock, then the insert: run as one batch; the insert's rows are last.
export function createAccountStatements(clerkUserId: string, name: string | null, email: string): Statement[] {
  return [accountLockStatement(clerkUserId), createAccountStatement(clerkUserId, name, email)];
}

export const ACCOUNT_DELETED_PATH = "/account-deleted";
