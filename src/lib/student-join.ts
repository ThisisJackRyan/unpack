import "server-only";
import type { StatementExecutor } from "./link-rate-limit";
import { neonExecutor } from "./neon-executor";
import { joinClassWith, type JoinOutcome } from "./student-join-core";
import type { JoinValues } from "./validate-join";

// Server-only: joins a class against Postgres (see student-join-core.ts for
// the steps and why they're race-safe). The action sets the cookie.

export type JoinClassOptions = {
  // For scripts/check-student-join.ts: a throttled executor, so a local
  // Postgres isn't flooded. The app passes nothing.
  execute?: StatementExecutor;
};

export function joinClass(
  data: JoinValues,
  ipHash: string,
  options: JoinClassOptions = {},
): Promise<JoinOutcome> {
  return joinClassWith(data, { execute: options.execute ?? neonExecutor, ipHash });
}
