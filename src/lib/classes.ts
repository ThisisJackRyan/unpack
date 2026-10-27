import "server-only";
import { and, asc, count, eq } from "drizzle-orm";
import { db, getSql, schema } from "@/db";
import type { Class, Teacher } from "@/db/schema";
import type { GradeLevel } from "./grade-levels";
import { withUniqueJoinCode } from "./join-code";
import type { StatementExecutor } from "./link-rate-limit";
import { neonExecutor } from "./neon-executor";
import { classGradeChangeStatements, insertedCount } from "./shared-questions";

// Server-only class queries, always scoped to the owning teacher.

export const FREE_PLAN_CLASS_LIMIT = 1;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// True for a well-formed uuid. Ids from the URL are checked first so a
// malformed one is a 404, not a Postgres uuid syntax error.
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function listClasses(teacherId: string): Promise<Class[]> {
  return db
    .select()
    .from(schema.classes)
    .where(eq(schema.classes.teacherId, teacherId))
    .orderBy(asc(schema.classes.createdAt));
}

export async function countClasses(teacherId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(schema.classes)
    .where(eq(schema.classes.teacherId, teacherId));
  return row?.value ?? 0;
}

// Free plan allows FREE_PLAN_CLASS_LIMIT classes; paid has no limit.
export function atClassLimit(teacher: Teacher, classCount: number): boolean {
  return teacher.plan === "free" && classCount >= FREE_PLAN_CLASS_LIMIT;
}

// Optional hooks for scripts/check-class-limit.ts; the app passes none.
// onRetry sees each join code collision that caused a retry.
export type InsertClassOptions = {
  generateJoinCode?: () => string;
  onRetry?: (error: unknown) => void;
};

// Inserts a class only if the teacher is paid or still under the free plan
// limit. Returns undefined when the plan limit blocks the insert.
//
// This must stay the ONLY code path that creates classes: the limit holds
// because every create takes the teacher row lock below, and an insert
// anywhere else would skip it.
//
// sql.transaction sends both statements as one non-interactive batch that
// Postgres runs as a single READ COMMITTED transaction, in order, holding
// locks until commit. Statement 1 locks the teacher row, so concurrent
// creates for the same teacher queue up there. Statement 2 starts after
// that wait, and READ COMMITTED gives each statement a fresh snapshot, so
// its count sees any class a previous holder committed. These must be TWO
// statements: one statement with a FOR UPDATE CTE would keep the snapshot
// taken when it started (before the lock wait) for the count subquery, and
// two creates could both count 0.
//
// A join code collision (23505) fails the batch, which rolls back and
// releases the lock; withUniqueJoinCode then retries with a new code.
export async function insertClassIfAllowed(
  teacherId: string,
  values: { name: string; gradeLevel: GradeLevel },
  options: InsertClassOptions = {},
): Promise<{ id: string } | undefined> {
  const sql = getSql();
  return withUniqueJoinCode(
    async (joinCode) => {
      const [, rows] = await sql.transaction(
        [
          sql`select id from teachers where id = ${teacherId} for update`,
          sql`
            insert into classes (teacher_id, name, grade_level, join_code)
            select t.id, ${values.name}, ${values.gradeLevel}::grade_level, ${joinCode}
            from teachers t
            where t.id = ${teacherId}
              and (
                t.plan = 'paid'
                or (select count(*) from classes c where c.teacher_id = t.id)
                  < ${FREE_PLAN_CLASS_LIMIT}
              )
            returning id
          `,
        ],
        { isolationLevel: "ReadCommitted" },
      );
      const row = rows[0] as { id: string } | undefined;
      return row && { id: row.id };
    },
    { generate: options.generateJoinCode, onConflict: options.onRetry },
  );
}

// Returns the class only if it belongs to the teacher. A malformed id
// returns undefined instead of a Postgres uuid syntax error.
export async function getClassForTeacher(
  classId: string,
  teacherId: string,
): Promise<Class | undefined> {
  if (!isUuid(classId)) return undefined;
  const [row] = await db
    .select()
    .from(schema.classes)
    .where(
      and(
        eq(schema.classes.id, classId),
        eq(schema.classes.teacherId, teacherId),
      ),
    )
    .limit(1);
  return row;
}

// Changes the class's grade and clears the shared questions of its drafts
// that follow the class grade (see classGradeChangeStatements). Returns
// false when the class isn't the teacher's. Not called by any page yet.
export async function updateClassGrade(
  classId: string,
  teacherId: string,
  gradeLevel: GradeLevel,
  execute: StatementExecutor = neonExecutor,
): Promise<boolean> {
  if (!isUuid(classId)) return false;
  return insertedCount(await execute(classGradeChangeStatements(classId, teacherId, gradeLevel))) === 1;
}
