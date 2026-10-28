// The real database side of the role-less sweep (roleless-clerk-sweep.ts),
// shared by the ops script and its db check, so both run the same
// statements: the lookup in a read-only transaction, and the under-13
// delete's local delete and confirm through neonExecutor (as
// under-13-server.ts does).

import { getSql } from "@/db";
import { confirmClerkDeletedStatement } from "@/lib/deleted-accounts";
import { neonExecutor } from "@/lib/neon-executor";
import { deleteRolelessAccountStatements, rolelessDeleteOutcome } from "@/lib/under-13-account";
import { sweepLookupStatements, type ListedRow, type RoleRow, type SweepDeps } from "./roleless-clerk-sweep";

export function sweepDbDeps(): Pick<SweepDeps, "lookup" | "deleteLocal" | "confirmClerkDeleted"> {
  return {
    lookup: async (ids) => {
      const sql = getSql();
      const [roleRows, listed] = (await sql.transaction(
        sweepLookupStatements(ids).map((s) => sql.query(s.text, s.params)),
        { isolationLevel: "ReadCommitted", readOnly: true },
      )) as unknown as [RoleRow[], ListedRow[]];
      return { roleRows, listed };
    },
    deleteLocal: async (id) => rolelessDeleteOutcome(await neonExecutor(deleteRolelessAccountStatements(id))),
    confirmClerkDeleted: async (id) => {
      await neonExecutor([confirmClerkDeletedStatement(id)]);
    },
  };
}
