// Joining a class: the steps after the form validates, over an injected
// executor, so tests run it with fakes and scripts/check-student-join.ts
// runs it against Postgres. The server action (src/app/join/actions.ts)
// adds the bot check, the cookie, and the redirect.
//
// 1. Record the attempt against the per-IP and per-code limits, in its own
//    transaction that commits first (see joinAttemptStatements). An unknown
//    code or a taken name still counts. If this throws, the join fails:
//    fail closed.
// 2. Insert the student, in one statement that also finds the class by
//    code, only while the code is on. No row back means no such class, or
//    its code is off; the student is told the same thing either way.
//    A second statement would let a teacher turn the code off between the
//    lookup and the insert.
// 3. The name is unique per class through students_class_id_name_key_unique
//    on students.name_key (studentNameKey), so when many students join with
//    the same name at once, the database picks exactly one winner and the
//    rest fail with 23505 on that constraint. There is no "is it taken?"
//    read first: that read could pass for two joins at once. A taken name
//    is refused, never resumed: progress is tied to the browser session,
//    not the name, so taking over a name would hand one student another's
//    work.

import { checkJoinLimit, joinRetryFromRows, joinRetryStatement, type JoinRetry } from "./join-rate-limit";
import type { Statement, StatementExecutor } from "./link-rate-limit";
import { studentNameKey } from "./student-name";
import { generateSessionToken, hashSessionToken } from "./student-session-token";
import { CLASS_NOT_FOUND_MESSAGE, type JoinErrors, type JoinValues } from "./validate-join";
import { hashJoinCode } from "./client-ip";

export const NAME_TAKEN_MESSAGE = "Someone already has that name. If it’s you, open unpack on the device you joined with, or add another letter.";

const NAME_KEY_CONSTRAINT = "students_class_id_name_key_unique";

export type JoinOutcome =
  | { status: "joined"; studentId: string; classId: string; token: string }
  // Unknown code, or the class's code is turned off.
  | { status: "class_not_found" }
  | { status: "name_taken" }
  // At the per-IP or per-code limit: which, and when the next join frees
  // up (null when that couldn't be read).
  | { status: "limited"; retry: JoinRetry };

// Postgres unique violation (23505) on the per-class name key. Drizzle and
// the Neon driver can wrap the error, so walk the cause chain (as
// isJoinCodeConflict does). A 23505 on any other constraint is not a name
// clash and must not be reported as one.
export function isNameTakenConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const { code, constraint, cause } = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (code === "23505" && constraint === NAME_KEY_CONSTRAINT) return true;
    current = cause;
  }
  return false;
}

// The insert of step 2. Only the token's hash goes to the database.
export function joinStudentStatement(data: JoinValues, tokenHash: string): Statement {
  return {
    text: `insert into students (class_id, first_name, last_initials, name_key, session_token_hash)
select c.id, $2::text, $3::text, $4::text, $5::text
from classes c
where c.join_code = $1::text and c.code_active
returning id, class_id`,
    params: [
      data.code,
      data.firstName,
      data.lastInitials,
      studentNameKey(data.firstName, data.lastInitials),
      tokenHash,
    ],
  };
}

export type JoinDeps = {
  execute: StatementExecutor;
  // The hashed client IP (see hashJoinIp).
  ipHash: string;
  newToken?: () => string;
};

// `data` must come from validateJoin. Errors other than a name clash
// propagate.
export async function joinClassWith(data: JoinValues, deps: JoinDeps): Promise<JoinOutcome> {
  const keys = { ipHash: deps.ipHash, codeHash: hashJoinCode(data.code) };
  const allowed = await checkJoinLimit(keys, deps.execute);
  if (!allowed) {
    // Only for the message: a failure here still refuses, with no time.
    let retry: JoinRetry = { by: "ip", retryAt: null };
    try {
      retry = joinRetryFromRows(await deps.execute([joinRetryStatement(keys)]));
    } catch {
      // Keep the default.
    }
    return { status: "limited", retry };
  }

  const token = (deps.newToken ?? generateSessionToken)();
  let rows: Record<string, unknown>[];
  try {
    [rows = []] = await deps.execute([joinStudentStatement(data, hashSessionToken(token))]);
  } catch (error) {
    if (isNameTakenConflict(error)) return { status: "name_taken" };
    throw error;
  }
  const [row] = rows;
  if (!row) return { status: "class_not_found" };
  return { status: "joined", studentId: String(row.id), classId: String(row.class_id), token };
}

// What the form shows for an outcome that's a mistake to fix. An unknown
// or turned-off code goes on the code field, like a malformed one (see
// validateJoin), so every "no such class" reads the same. "limited" isn't
// here: the join action shows it as an amber note with a retry time.
export function joinOutcomeErrors(
  outcome: Exclude<JoinOutcome, { status: "joined" | "limited" }>,
): JoinErrors {
  switch (outcome.status) {
    case "class_not_found":
      return { code: CLASS_NOT_FOUND_MESSAGE };
    case "name_taken":
      return { lastInitials: NAME_TAKEN_MESSAGE };
  }
}
