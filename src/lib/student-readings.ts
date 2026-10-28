import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Reading } from "@/db/schema";
import { isUuid } from "./classes";
import { listSharedQuestions } from "./shared-questions-db";
import type { StudentSession } from "./student-lookup";
import { getOrCreateStudentQuestions, type GetStudentQuestionsOptions } from "./student-questions";
import type { RetryClock } from "./local-time";
import { perStudentView, sharedView, type StudentReadingView } from "./student-reading-view";
import { elapsedMs, monotonicNow, pageReadySource, type Clock, type PageReadySource } from "./timing-log";

// Server-only reading queries for students. Every one is scoped to the
// student's own class and to published readings: a draft, or a reading in
// another class, is "not found", the same as an id that doesn't exist.

export type StudentReading = Pick<
  Reading,
  "id" | "title" | "questionCount" | "questionMode" | "bodyText" | "sourceUrl"
>;

// The class's published readings, with the student's status on each, are
// listReadingsWithStatus (reading-progress-db.ts).

export async function getPublishedReading(
  classId: string,
  readingId: string,
): Promise<StudentReading | undefined> {
  if (!isUuid(readingId)) return undefined;
  const [row] = await db
    .select({
      id: schema.readings.id,
      title: schema.readings.title,
      questionCount: schema.readings.questionCount,
      questionMode: schema.readings.questionMode,
      bodyText: schema.readings.bodyText,
      sourceUrl: schema.readings.sourceUrl,
    })
    .from(schema.readings)
    .where(
      and(
        eq(schema.readings.id, readingId),
        eq(schema.readings.classId, classId),
        eq(schema.readings.status, "published"),
      ),
    )
    .limit(1);
  return row;
}

// timing: for the questions.page_ready log (timing-log.ts). questionsMs
// covers resolving the questions only (the reading lookup is before it).
export type StudentReadingTiming = { source: PageReadySource; questionsMs: number };

export type StudentReadingPage =
  | { reading: StudentReading; view: StudentReadingView; timing: StudentReadingTiming }
  | { reading: null; view: { kind: "not_found" }; timing: StudentReadingTiming };

// The reading and what to show for it. In per-student mode this is where a
// student's set is written on first open, which can take as long as a
// model call (the page allows for it with maxDuration).
export async function loadStudentReading(
  session: StudentSession,
  readingId: string,
  // For scripts/check-student-join.ts (a mock model); the app passes none.
  options: GetStudentQuestionsOptions = {},
  // Now and the reader's zone, for a "Try again" retry time.
  clock: RetryClock | null = null,
  // Monotonic milliseconds, for timing.questionsMs.
  now: Clock = monotonicNow,
): Promise<StudentReadingPage> {
  const reading = await getPublishedReading(session.class.id, readingId);
  if (!reading) return { reading: null, view: { kind: "not_found" }, timing: { source: "not_found", questionsMs: 0 } };
  const started = now();
  let generated = false;
  const view =
    reading.questionMode === "shared"
      ? sharedView(await listSharedQuestions(reading.id))
      : perStudentView(
          await getOrCreateStudentQuestions(reading.id, session.student.id, {
            ...options,
            onWrite: () => (generated = true),
          }),
          clock,
        );
  const timing = {
    source: pageReadySource(view, reading.questionMode, generated),
    questionsMs: elapsedMs(started, now),
  };
  if (view.kind === "not_found") return { reading: null, view, timing };
  return { reading, view, timing };
}
