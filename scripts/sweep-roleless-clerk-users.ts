// Ops: deletes left-behind role-less Clerk accounts. Someone who signs in
// but never chooses a role on /welcome leaves a Clerk account (with its
// email) and maybe a teachers row with no role (with the name and email).
// This finds the ones older than a threshold and, only with --apply,
// deletes them. See scripts/lib/roleless-clerk-sweep.ts for what counts as
// role-less, the guards, and how each delete runs.
//
//   DATABASE_URL=... CLERK_SECRET_KEY=... pnpm ops:sweep-roleless-clerk-users \
//     --expect-db=<host>/<dbname> --expect-instance=<ins_id>
//   (then the --apply command the dry run prints, with --expect-count=N)
//
// Guards, each refusing before anything changes:
// - Environment, before any Clerk user is listed or any row looked up:
//   prints the Clerk instance id and environment type (GET /v1/instance),
//   the key type (sk_live or sk_test, from the prefix), and the database
//   host and name from DATABASE_URL (never the user, password, or key).
//   Refuses a live/test mismatch (a sk_test key needs a development
//   instance and a local or test database, as the db checks define it; a
//   sk_live key needs the opposite of both), and any difference from the
//   REQUIRED --expect-db=<host>/<dbname> and --expect-instance=<ins_id>.
// - Shape, after the lookup: aborts if none of the aged Clerk users has a
//   teachers row, or if at least 10 are aged and more than half of them
//   have none (the wrong database for this instance looks like that).
// - Count, with --apply: --expect-count=N is required and must equal the
//   candidates this run found.
//
// Dry run by default: pages through every Clerk user (Backend API, GET
// /v1/users; only id, created_at, last_sign_in_at and last_active_at are
// read), keeps those both created and last seen (the latest of the three
// times) at least --min-age-days ago (default 7, never under 7), looks
// their ids up in a read-only transaction, and prints the count and, per
// role-less account, the Clerk id, a 12-character hash prefix, which kind
// it is, and how many days ago it was last seen; then the totals per kind,
// a 12-character digest of the sorted ids (the same digest means the same
// accounts, not only the same count), and the exact --apply command to
// copy. Nothing is written and no DELETE is sent.
//
// --apply: deletes up to --limit accounts (default 25, at most 500),
// oldest first. Each one is re-checked in the same transaction as the
// local delete (the under-13 delete's deleteRolelessAccountStatements:
// account lock, role still null, hash listed as pending), then deleted in
// Clerk (DELETE /v1/users/{id}), then the hash confirmed. The hash is
// recorded on purpose: it is what stops a late user.created or a session
// that outlived the account from making a new row with the name and
// email, exactly as for any other deleted account (deleted-accounts.ts),
// and it is pruned 30 days after the confirm. The first failed Clerk
// delete stops the run with only its HTTP status printed.
//
// Refuses unknown arguments. Prints nothing secret from the environment
// (only the database host and name), and no email, name, phone, or
// anything else from Clerk. NEON_FETCH_ENDPOINT, if set, points the
// driver at a local Neon proxy (as in the db checks).

import { neonConfig } from "@neondatabase/serverless";
import { ClerkListError } from "./lib/pending-clerk-deletes";
import { parseOptions, runSweep, USAGE } from "./lib/roleless-clerk-sweep";
import { sweepDbDeps } from "./lib/roleless-clerk-sweep-db";

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if ("help" in options) {
    console.log(USAGE);
    return;
  }
  if ("error" in options) {
    console.error(options.error);
    process.exit(2);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set.");
    process.exit(2);
  }
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    console.error("CLERK_SECRET_KEY is not set.");
    process.exit(2);
  }

  const fetchEndpoint = process.env.NEON_FETCH_ENDPOINT;
  if (fetchEndpoint) neonConfig.fetchEndpoint = () => fetchEndpoint;
  const result = await runSweep(options, {
    fetchFn: fetch,
    secretKey,
    databaseUrl,
    ...sweepDbDeps(),
    print: (line) => console.log(line),
    now: new Date(),
  });
  if (result.stoppedStatus !== null || result.aborted !== null) process.exit(1);
}

main().catch((error) => {
  // Name and code only (a driver message can name the database user or
  // host); our own Clerk errors carry just an HTTP status.
  if (error instanceof ClerkListError) console.error("sweep-roleless-clerk-users failed:", error.message);
  else {
    const { name, code } = error as { name?: unknown; code?: unknown };
    console.error("sweep-roleless-clerk-users failed:", name, code);
  }
  process.exit(1);
});
