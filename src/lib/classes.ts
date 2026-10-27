import { and, asc, count, eq } from "drizzle-orm";
import { db, getSql, schema } from "@/db";
import type { Class, Teacher } from "@/db/schema";
import type { GradeLevel } from "./grade-levels";
import { withUniqueJoinCode } from "./join-code";

// Server-only class queries, always scoped to the owning teacher.

export const FREE_PLAN_CLASS_LIMIT = 1;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

const SERIALIZATION_FAILURE = "40001";
const MAX_SERIALIZATION_RETRIES = 3;

// Inserts a class only if the teacher is paid or still under the free plan
// limit, checked in the same statement as the insert. The statement runs at
// SERIALIZABLE: at Postgres's default READ COMMITTED, two concurrent inserts
// could each miss the other's row and both succeed. Retries on a join code
// collision and on a serialization failure (a concurrent create). Returns
// undefined when the plan limit blocks the insert.
export async function insertClassIfAllowed(
  teacherId: string,
  values: { name: string; gradeLevel: GradeLevel },
): Promise<{ id: string } | undefined> {
  const sql = getSql();
  for (let attempt = 1; ; attempt++) {
    try {
      return await withUniqueJoinCode(async (joinCode) => {
        const [rows] = await sql.transaction(
          [
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
          { isolationLevel: "Serializable" },
        );
        const row = rows[0] as { id: string } | undefined;
        return row && { id: row.id };
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== SERIALIZATION_FAILURE || attempt >= MAX_SERIALIZATION_RETRIES) {
        throw error;
      }
    }
  }
}

// Returns the class only if it belongs to the teacher. A malformed id
// returns undefined instead of a Postgres uuid syntax error.
export async function getClassForTeacher(
  classId: string,
  teacherId: string,
): Promise<Class | undefined> {
  if (!UUID_RE.test(classId)) return undefined;
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
