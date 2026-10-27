import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { hashSessionToken } from "./student-session-token";

// Server-only: the student behind a session token. The cookie holds the
// raw token; the lookup is by its hash, the only form stored. No Next
// imports, so scripts/check-student-join.ts can call it; student-auth.ts
// reads the cookie.

export type StudentSession = {
  student: { id: string; firstName: string; lastInitials: string };
  class: { id: string; name: string };
};

// The student and their class for a raw session token, or null when no
// student has it (never issued, or the student or class was deleted).
// Joining only needs the code on, not later visits: a class whose code is
// turned off keeps its joined students.
export async function findStudentBySessionToken(token: string): Promise<StudentSession | null> {
  const [row] = await db
    .select({
      student: {
        id: schema.students.id,
        firstName: schema.students.firstName,
        lastInitials: schema.students.lastInitials,
      },
      class: { id: schema.classes.id, name: schema.classes.name },
    })
    .from(schema.students)
    .innerJoin(schema.classes, eq(schema.classes.id, schema.students.classId))
    .where(eq(schema.students.sessionTokenHash, hashSessionToken(token)))
    .limit(1);
  return row ?? null;
}
