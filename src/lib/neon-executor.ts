import "server-only";
import { getSql } from "@/db";
import type { StatementExecutor } from "./link-rate-limit";

// Server-only: runs statements as one non-interactive batch, which Neon
// runs as a single READ COMMITTED transaction, in order, holding locks
// until commit. The same executor link-fetch-attempts.ts uses, shared by
// the question modules.
export const neonExecutor: StatementExecutor = async (statements) => {
  const sql = getSql();
  const results = await sql.transaction(
    statements.map((s) => sql.query(s.text, s.params)),
    { isolationLevel: "ReadCommitted" },
  );
  return results as Record<string, unknown>[][];
};
