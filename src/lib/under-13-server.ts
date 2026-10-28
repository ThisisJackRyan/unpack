import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import { neonExecutor } from "./neon-executor";
import { confirmClerkDeletedStatement } from "./deleted-accounts";
import { deleteRolelessAccountStatements, rolelessDeleteOutcome, type Under13DeleteDeps } from "./under-13-account";

// Server-only: the real dependencies of the under-13 delete (see
// under-13-account.ts). The log gets only what that file passes: a fixed
// tag and fixed words, never an id.
export const under13DeleteDeps: Under13DeleteDeps = {
  deleteLocal: async (clerkUserId) => rolelessDeleteOutcome(await neonExecutor(deleteRolelessAccountStatements(clerkUserId))),
  deleteClerkUser: async (clerkUserId) => (await clerkClient()).users.deleteUser(clerkUserId),
  confirmClerkDeleted: async (clerkUserId) => {
    await neonExecutor([confirmClerkDeletedStatement(clerkUserId)]);
  },
  log: (level, message, fields) => (level === "error" ? console.error : console.info)(message, fields),
};
