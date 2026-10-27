// Rate limits on joining a class, per IP and per class code. Every join
// attempt that reaches the database counts, before any other work, whether
// it then joins, hits an unknown code, or finds the name taken. (A form
// that fails validation never touches the database and isn't counted.)
//
// Keys are SHA-256 hex digests (see client-ip.ts), so join_attempts never
// holds a raw IP address. Rows are deleted once they are older than the
// window, so a hashed IP is kept for about JOIN_WINDOW_MINUTES.
//
// Pure statements, so tests can check them with a fake executor. The
// server-only runner is student-join.ts.

import type { Statement, StatementExecutor } from "./link-rate-limit";

// Per IP: schools put a whole building behind one NAT address, so this has
// to let a full class (or two) join at once, with retries for typos and
// taken names: 60 per 10 minutes.
export const JOIN_IP_LIMIT = 60;
// Per code: a class of 30 with room for typos and a second period sharing
// the code, while capping guessing at one code from many addresses: 100 per
// 10 minutes.
export const JOIN_CODE_LIMIT = 100;
export const JOIN_WINDOW_MINUTES = 10;
// Most expired rows (of any key) deleted per attempt. Each attempt adds at
// most 2, so this keeps up with any load while keeping each prune small.
export const JOIN_PRUNE_BATCH = 200;

export const JOIN_LIMITED_MESSAGE = "Too many tries. Wait a few minutes and try again.";

export type JoinLimitKeys = { ipHash: string; codeHash: string };

// Advisory lock namespaces (the first int of the two-int form), so an IP
// key and a code key whose hashtext() collide never share a lock.
const IP_LOCK_SPACE = 1;
const CODE_LOCK_SPACE = 2;

// Why these four statements, in one READ COMMITTED transaction (the same
// shape as linkFetchStatements, with advisory locks since there's no row to
// lock for an IP or a code that may not exist):
//
// 1-2. Take a transaction-scoped advisory lock on the IP key, then on the
//    code key, so attempts sharing either key queue up here for a few
//    milliseconds. Always IP first, then code, so two attempts can't each
//    hold the lock the other wants. A hashtext() collision only makes two
//    keys share a lock (more queuing, never a wrong count).
// 3. Insert one row per key, only if BOTH keys are under their limits in
//    the window. This statement's fresh snapshot, taken after the lock
//    waits, sees every attempt a previous holder committed, so the limits
//    are exact: 90 at once from one IP get exactly 60. A refused attempt
//    records nothing, so hammering past the limit doesn't extend the wait
//    and doesn't use up the other key's budget.
// 4. Delete up to JOIN_PRUNE_BATCH expired rows of any key. This is what
//    keeps a hashed IP for only the window, without a cron job (a key with
//    no later attempts anywhere waits for the next join to be pruned). SKIP
//    LOCKED so two prunes never wait on each other while holding locks.
export function joinAttemptStatements(keys: JoinLimitKeys): Statement[] {
  return [
    {
      text: "select pg_advisory_xact_lock($1::int, hashtext($2::text))",
      params: [IP_LOCK_SPACE, keys.ipHash],
    },
    {
      text: "select pg_advisory_xact_lock($1::int, hashtext($2::text))",
      params: [CODE_LOCK_SPACE, keys.codeHash],
    },
    {
      text: `insert into join_attempts (key_kind, key_hash)
select k.kind, k.hash
from (values ('ip', $1::text), ('code', $2::text)) as k(kind, hash)
where (
  select count(*) from join_attempts
  where key_kind = 'ip' and key_hash = $1::text
    and created_at > now() - make_interval(mins => $3::int)
) < $4::int
and (
  select count(*) from join_attempts
  where key_kind = 'code' and key_hash = $2::text
    and created_at > now() - make_interval(mins => $3::int)
) < $5::int
returning key_kind`,
      params: [keys.ipHash, keys.codeHash, JOIN_WINDOW_MINUTES, JOIN_IP_LIMIT, JOIN_CODE_LIMIT],
    },
    {
      text: `delete from join_attempts
where id in (
  select id from join_attempts
  where created_at < now() - make_interval(mins => $1::int)
  order by created_at
  limit $2::int
  for update skip locked
)`,
      params: [JOIN_WINDOW_MINUTES, JOIN_PRUNE_BATCH],
    },
  ];
}

// Records the attempt and returns true if it may go ahead, or false
// (recording nothing) when either key is at its limit. Executor errors
// propagate, so the caller fails closed.
export async function checkJoinLimit(
  keys: JoinLimitKeys,
  execute: StatementExecutor,
): Promise<boolean> {
  const results = await execute(joinAttemptStatements(keys));
  return (results[2]?.length ?? 0) === 2;
}
