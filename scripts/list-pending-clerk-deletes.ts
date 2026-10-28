// Ops: lists the deleted-account rows whose Clerk delete is still pending
// (deleted_clerk_users.clerk_deleted_at is null; see
// src/lib/deleted-accounts.ts). A pending row is an under-13 delete
// (src/lib/under-13-account.ts) whose two deleteUser calls failed, and
// the sign-in retry hasn't worked yet either: our row and data are gone,
// but the Clerk account (with its email) may still exist. Pending rows are
// never pruned, so that account can never get a row back; this finds them
// so someone can finish the delete in Clerk.
//
//   DATABASE_URL=... pnpm ops:list-pending-clerk-deletes
//   DATABASE_URL=... CLERK_SECRET_KEY=... pnpm ops:list-pending-clerk-deletes --match-clerk
//
// Without flags: the count, then per row a 12-character prefix of its hash
// and when it was listed. Reads the database in a read-only transaction.
//
// --match-clerk (needs CLERK_SECRET_KEY): we store only a hash of the
// Clerk id, and an id can't be recovered from it, but ops needs the id to
// delete the account in the Clerk dashboard. So this pages through every
// Clerk user (Backend API, GET /v1/users, read only), hashes each id the
// same way (hashClerkUserId), and prints the ids that match a pending
// row. Only the id is read from a user object: no email, name, phone, or
// anything else is printed. A pending row no Clerk user matches is
// already gone in Clerk (its user.deleted never reached us); it is listed
// by prefix and kept (hash only, nothing personal).
//
// No delete mode, on purpose: ops deletes each listed id in the Clerk
// dashboard, Clerk sends user.deleted, and the webhook confirms the row
// (the normal path; nothing here writes). Run it again to see the list
// shrink.
//
// Refuses unknown arguments. Prints nothing from the environment.
// NEON_FETCH_ENDPOINT, if set, points the driver at a local Neon proxy
// (as in the db checks); production needs nothing beyond DATABASE_URL.

import { neonConfig } from "@neondatabase/serverless";
import { getSql } from "@/db";
import { pendingClerkDeletesStatement } from "@/lib/deleted-accounts";
import {
  ClerkListError,
  formatMatchReport,
  formatPendingReport,
  listClerkUserIds,
  matchPendingClerkIds,
  parseOptions,
  USAGE,
  type PendingRow,
} from "./lib/pending-clerk-deletes";

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
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(2);
  }
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (options.matchClerk && !secretKey) {
    console.error("--match-clerk needs CLERK_SECRET_KEY.");
    process.exit(2);
  }

  const fetchEndpoint = process.env.NEON_FETCH_ENDPOINT;
  if (fetchEndpoint) neonConfig.fetchEndpoint = () => fetchEndpoint;
  const sql = getSql();
  const statement = pendingClerkDeletesStatement();
  const [rows] = (await sql.transaction([sql.query(statement.text, statement.params)], {
    isolationLevel: "ReadCommitted",
    readOnly: true,
  })) as unknown as PendingRow[][];
  for (const line of formatPendingReport(rows, new Date())) console.log(line);

  if (options.matchClerk && secretKey && rows.length > 0) {
    const ids = await listClerkUserIds(fetch, secretKey);
    const pending = new Set(rows.map((r) => r.clerk_user_hash));
    console.log(`\nChecked ${ids.length} Clerk users.`);
    for (const line of formatMatchReport(matchPendingClerkIds(ids, pending), pending)) console.log(line);
  }
}

main().catch((error) => {
  // Name and code only (a driver message can name the database user or
  // host); our own Clerk errors carry just an HTTP status.
  if (error instanceof ClerkListError) console.error("list-pending-clerk-deletes failed:", error.message);
  else {
    const { name, code } = error as { name?: unknown; code?: unknown };
    console.error("list-pending-clerk-deletes failed:", name, code);
  }
  process.exit(1);
});
