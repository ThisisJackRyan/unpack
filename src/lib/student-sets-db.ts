import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { groupStudentSets, type StudentSet } from "./student-sets";

// Server-only: the saved per-student question sets of one reading, for its
// teacher. Callers check ownership first (the reading came from
// getReadingForTeacher); the class filter keeps it to that class's
// students as well. Only saved sets are listed: a set being written right
// now appears once it lands.
export async function listStudentSets(readingId: string, classId: string): Promise<StudentSet[]> {
  const rows = await db
    .select({
      studentId: schema.students.id,
      firstName: schema.students.firstName,
      lastInitials: schema.students.lastInitials,
      questionId: schema.questions.id,
      position: schema.questions.position,
      prompt: schema.questions.prompt,
    })
    .from(schema.questions)
    .innerJoin(schema.students, eq(schema.students.id, schema.questions.studentId))
    .where(and(eq(schema.questions.readingId, readingId), eq(schema.students.classId, classId)))
    .orderBy(
      // name_key is lowercased, so "maya" and "Maya" sort together.
      asc(schema.students.nameKey),
      asc(schema.students.id),
      asc(schema.questions.position),
    );
  return groupStudentSets(rows);
}
