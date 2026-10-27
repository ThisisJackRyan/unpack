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
// listed (one statement, so a delete committed first always wins).
//
// What is stored: only clerk_user_hash, SHA-256 of "deleted-clerk-user:"
// plus the Clerk user id, and deleted_at. Not keyed with a server secret
// (unlike the join IP hash, client-ip.ts): a Clerk id is a long random
// string, not something you can enumerate the way you can IPv4 addresses,
// so the hash can't be reversed by guessing, and with no key there is no
// new production secret to set and no rotation that would silently empty
// the list. Someone who already has the raw id (Clerk, or a copy of our
// old row) could confirm it was deleted, nothing more.
//
// Retention: DELETED_ACCOUNT_RETENTION_DAYS (30) after the delete, then
// pruned by the next account delete (so a quiet stretch can keep a row
// longer, until the next delete). Clerk's retries end within a few days,
// and Clerk never reuses a user id, so 30 days is comfortably past any
// late delivery. See docs/privacy.md.

import { createHash } from "node:crypto";
import type { Statement } from "./link-rate-limit";

export const DELETED_ACCOUNT_RETENTION_DAYS = 30;

// The most expired rows one delete prunes, so each prune stays small.
export const DELETED_ACCOUNT_PRUNE_BATCH = 200;

export function hashClerkUserId(clerkUserId: string): string {
  return createHash("sha256").update(`deleted-clerk-user:${clerkUserId}`, "utf8").digest("hex");
}

// SQL: the hash given as parameter $n is not on the list.
export function notDeletedSql(n: number): string {
  return `not exists (select 1 from deleted_clerk_users where clerk_user_hash = $${n}::text)`;
}

// Lists the id (a repeat delete keeps the first time).
export function recordDeletedStatement(clerkUserId: string): Statement {
  return {
    text: `insert into deleted_clerk_users (clerk_user_hash) values ($1::text)
on conflict (clerk_user_hash) do nothing`,
    params: [hashClerkUserId(clerkUserId)],
  };
}

// Deletes up to a batch of rows older than the retention period.
export function pruneDeletedStatement(): Statement {
  return {
    text: `delete from deleted_clerk_users
where clerk_user_hash in (
  select clerk_user_hash from deleted_clerk_users
  where deleted_at < now() - make_interval(days => $1::int)
  order by deleted_at
  limit $2::int
  for update skip locked
)`,
    params: [DELETED_ACCOUNT_RETENTION_DAYS, DELETED_ACCOUNT_PRUNE_BATCH],
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
// existing row keeps its role (the update sets only name and email).
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

export const ACCOUNT_DELETED_PATH = "/account-deleted";
