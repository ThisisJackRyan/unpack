import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db, getSql, schema } from "@/db";
import type { Class, Reading } from "@/db/schema";
import { isUuid } from "./classes";
import type { StatementExecutor } from "./link-rate-limit";
import { neonExecutor } from "./neon-executor";
import { editApplied, editReadingStatements } from "./shared-questions";
import type { ReadingSettings } from "./validate-reading";

// Server-only reading queries. Every one is scoped to the owning teacher in
// the same statement: a reading counts only if its class belongs to them.

export type ReadingDraft = ReadingSettings & {
  title: string;
  bodyText: string;
  sourceUrl: string | null;
};

export type ReadingListItem = Pick<
  Reading,
  "id" | "title" | "status" | "questionCount" | "questionMode" | "createdAt"
>;

export type ReadingWithClass = {
  reading: Reading;
  class: Pick<Class, "id" | "name" | "gradeLevel">;
};

// The class's readings, newest first. Empty when the class isn't theirs.
export function listReadings(
  classId: string,
  teacherId: string,
): Promise<ReadingListItem[]> {
  if (!isUuid(classId)) return Promise.resolve([]);
  return db
    .select({
      id: schema.readings.id,
      title: schema.readings.title,
      status: schema.readings.status,
      questionCount: schema.readings.questionCount,
      questionMode: schema.readings.questionMode,
      createdAt: schema.readings.createdAt,
    })
    .from(schema.readings)
    .innerJoin(schema.classes, eq(schema.classes.id, schema.readings.classId))
    .where(
      and(
        eq(schema.readings.classId, classId),
        eq(schema.classes.teacherId, teacherId),
      ),
    )
    .orderBy(desc(schema.readings.createdAt), desc(schema.readings.id));
}

// The reading and its class, only if the reading is in that class and the
// class belongs to the teacher. Malformed ids return undefined.
export async function getReadingForTeacher(
  classId: string,
  readingId: string,
  teacherId: string,
): Promise<ReadingWithClass | undefined> {
  if (!isUuid(classId) || !isUuid(readingId)) return undefined;
  const [row] = await db
    .select({
      reading: schema.readings,
      class: {
        id: schema.classes.id,
        name: schema.classes.name,
        gradeLevel: schema.classes.gradeLevel,
      },
    })
    .from(schema.readings)
    .innerJoin(schema.classes, eq(schema.classes.id, schema.readings.classId))
    .where(
      and(
        eq(schema.readings.id, readingId),
        eq(schema.readings.classId, classId),
        eq(schema.classes.teacherId, teacherId),
      ),
    )
    .limit(1);
  return row;
}

// Adds a draft reading to the class if the class belongs to the teacher.
// Returns undefined when it doesn't (nothing is inserted).
export async function insertReading(
  classId: string,
  teacherId: string,
  draft: ReadingDraft,
): Promise<{ id: string } | undefined> {
  if (!isUuid(classId)) return undefined;
  const sql = getSql();
  const rows = await sql`
    insert into readings
      (class_id, title, source_url, body_text, grade_level, question_count, question_mode, status)
    select c.id, ${draft.title}, ${draft.sourceUrl}, ${draft.bodyText},
      ${draft.gradeLevel}::grade_level, ${draft.questionCount},
      ${draft.questionMode}::question_mode, 'draft'
    from classes c
    where c.id = ${classId} and c.teacher_id = ${teacherId}
    returning id
  `;
  const row = rows[0] as { id: string } | undefined;
  return row && { id: row.id };
}

// Saves the edit page: any change to a draft (clearing its shared
// questions if they no longer fit), or a title-only change to a published
// reading (see editReadingStatements). Returns false (and changes nothing)
// when the reading isn't the teacher's or isn't in that class, or when it
// is published and anything but the title changed.
export async function saveReadingEdit(
  classId: string,
  readingId: string,
  teacherId: string,
  edit: Omit<ReadingDraft, "sourceUrl">,
  execute: StatementExecutor = neonExecutor,
): Promise<boolean> {
  if (!isUuid(classId) || !isUuid(readingId)) return false;
  return editApplied(await execute(editReadingStatements({ classId, readingId, teacherId }, edit)));
}
