import "server-only";
import { getSql } from "@/db";
import { checkLinkFetchLimit, type StatementExecutor } from "./link-rate-limit";

// Server-only: runs the link fetch rate limit against Postgres. sql.transaction
// sends the statements as one non-interactive batch, run as a single READ
// COMMITTED transaction (see linkFetchStatements for why).
const neonExecutor: StatementExecutor = async (statements) => {
  const sql = getSql();
  const results = await sql.transaction(
    statements.map((s) => sql.query(s.text, s.params)),
    { isolationLevel: "ReadCommitted" },
  );
  return results as Record<string, unknown>[][];
};

export function recordLinkFetchAttempt(teacherId: string): Promise<boolean> {
  return checkLinkFetchLimit(teacherId, neonExecutor);
}
