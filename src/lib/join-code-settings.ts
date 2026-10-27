// The teacher's join code controls on the class page: turn the code on or
// off, and make a new code. Pure statements and flow over an injected
// executor, so tests run them with fakes and
// scripts/check-abuse-protection.ts runs them against Postgres.
//
// Race safety:
// - Ownership is in the same statement as the write (where id = class and
//   teacher_id = teacher), so another teacher's request changes nothing
//   and gets "not_found", with no window between a check and the update.
// - On/off sets the value asked for, not a flip, so a double click or two
//   tabs end where the teacher last pointed.
// - A new code is one update of classes.join_code. Concurrent ones queue
//   on the class row and each replaces the last: exactly one current code
//   at the end, and every earlier one is gone. A code that's another
//   class's fails with 23505 on classes_join_code_unique and is retried
//   with a fresh one (withUniqueJoinCode, as creating a class does).
// - Joining finds the class by code in its insert (student-join-core.ts),
//   so once the update commits the old code finds nothing: it stops
//   working right away, with the same "couldn't find" message as any
//   unknown code. Turning the code off works the same way.
// - Students who already joined keep access: their session is the hash on
//   their students row, tied to the student and class, never to the code
//   (see student-lookup.ts).

import { withUniqueJoinCode, type JoinCodeOptions } from "./join-code";
import type { Statement, StatementExecutor } from "./link-rate-limit";

export const JOIN_CODE_ON_MESSAGE = "Join code is on. Students can join with it.";
export const JOIN_CODE_OFF_MESSAGE = "Join code is off. No one new can join.";
export const JOIN_CODE_SAVE_FAILED_MESSAGE = "We couldn’t save that. Please try again.";
export const JOIN_CODE_NEW_FAILED_MESSAGE = "We couldn’t make a new code. Please try again.";

export function newCodeMessage(code: string): string {
  return `New code ready: ${code}. The old code no longer works.`;
}

// $1 class, $2 teacher, $3 on or off.
export function setCodeActiveStatement(classId: string, teacherId: string, active: boolean): Statement {
  return {
    text: `update classes set code_active = $3::boolean
where id = $1::uuid and teacher_id = $2::uuid
returning code_active`,
    params: [classId, teacherId, active],
  };
}

// $1 class, $2 teacher, $3 the new code.
export function newCodeStatement(classId: string, teacherId: string, code: string): Statement {
  return {
    text: `update classes set join_code = $3::text
where id = $1::uuid and teacher_id = $2::uuid
returning join_code`,
    params: [classId, teacherId, code],
  };
}

export type SetCodeActiveResult = { status: "saved"; active: boolean } | { status: "not_found" };

export async function setCodeActiveWith(
  classId: string,
  teacherId: string,
  active: boolean,
  execute: StatementExecutor,
): Promise<SetCodeActiveResult> {
  const [rows = []] = await execute([setCodeActiveStatement(classId, teacherId, active)]);
  const [row] = rows;
  return row ? { status: "saved", active: row.code_active === true } : { status: "not_found" };
}

export type NewCodeResult = { status: "saved"; code: string } | { status: "not_found" };

// Throws JoinCodeExhaustedError if every try collided, and any other
// executor error, so the caller fails closed (nothing changed).
export async function newJoinCodeWith(
  classId: string,
  teacherId: string,
  execute: StatementExecutor,
  options: JoinCodeOptions = {},
): Promise<NewCodeResult> {
  return withUniqueJoinCode(async (code) => {
    const [rows = []] = await execute([newCodeStatement(classId, teacherId, code)]);
    const [row] = rows;
    return row ? { status: "saved", code: String(row.join_code) } : { status: "not_found" };
  }, options);
}
