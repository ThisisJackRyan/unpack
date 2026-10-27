import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { GRADE_LEVELS } from "../lib/grade-levels";

// Enums

export const planEnum = pgEnum("plan", ["free", "paid"]);
export const questionModeEnum = pgEnum("question_mode", [
  "shared",
  "per_student",
]);
export const readingStatusEnum = pgEnum("reading_status", [
  "draft",
  "published",
]);
export const gradeLevelEnum = pgEnum("grade_level", GRADE_LEVELS);
export const attemptResultEnum = pgEnum("attempt_result", ["pass", "fail"]);
export const challengeStatusEnum = pgEnum("challenge_status", [
  "open",
  "approved",
  "denied",
]);

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// Tables

export const teachers = pgTable("teachers", {
  id: uuid("id").primaryKey().defaultRandom(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  name: text("name"),
  email: text("email").notNull(),
  plan: planEnum("plan").notNull().default("free"),
  createdAt: createdAt(),
});

export const classes = pgTable(
  "classes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teacherId: uuid("teacher_id")
      .notNull()
      .references(() => teachers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    gradeLevel: gradeLevelEnum("grade_level").notNull(),
    joinCode: text("join_code").notNull().unique(),
    codeActive: boolean("code_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("classes_teacher_id_idx").on(t.teacherId)],
);

export const readings = pgTable(
  "readings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    classId: uuid("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sourceUrl: text("source_url"),
    bodyText: text("body_text").notNull(),
    // Overrides the class grade level when set.
    gradeLevel: gradeLevelEnum("grade_level"),
    questionCount: integer("question_count").notNull().default(3),
    questionMode: questionModeEnum("question_mode").notNull().default("shared"),
    status: readingStatusEnum("status").notNull().default("draft"),
    createdAt: createdAt(),
  },
  (t) => [
    index("readings_class_id_idx").on(t.classId),
    check(
      "readings_question_count_check",
      sql`${t.questionCount} between 1 and 10`,
    ),
  ],
);

export const students = pgTable(
  "students",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    classId: uuid("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    firstName: text("first_name").notNull(),
    lastInitials: text("last_initials").notNull(),
    // Normalized first_name + last_initials (see studentNameKey) so the
    // per-class uniqueness check ignores case and extra whitespace.
    nameKey: text("name_key").notNull(),
    // SHA-256 hex of the raw session token; the raw token is only in the cookie.
    sessionTokenHash: text("session_token_hash").notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("students_class_id_name_key_unique").on(t.classId, t.nameKey),
  ],
);

export const questions = pgTable(
  "questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    readingId: uuid("reading_id")
      .notNull()
      .references(() => readings.id, { onDelete: "cascade" }),
    // Null for shared questions; set for per-student question sets.
    studentId: uuid("student_id").references(() => students.id, {
      onDelete: "cascade",
    }),
    position: integer("position").notNull(),
    prompt: text("prompt").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("questions_reading_id_student_id_idx").on(t.readingId, t.studentId),
    index("questions_student_id_idx").on(t.studentId),
    // One question per position in each set. NULLS NOT DISTINCT so the
    // shared set (student_id null) is covered too: two writers can't both
    // insert position 1. The backstop behind the conditional writes in
    // src/lib/shared-questions.ts and src/lib/student-questions-core.ts.
    unique("questions_reading_student_position_unique")
      .on(t.readingId, t.studentId, t.position)
      .nullsNotDistinct(),
  ],
);

export const attempts = pgTable(
  "attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    readingId: uuid("reading_id")
      .notNull()
      .references(() => readings.id, { onDelete: "cascade" }),
    tryNumber: integer("try_number").notNull(),
    result: attemptResultEnum("result").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("attempts_student_reading_try_unique").on(
      t.studentId,
      t.readingId,
      t.tryNumber,
    ),
    index("attempts_reading_id_idx").on(t.readingId),
    check("attempts_try_number_check", sql`${t.tryNumber} between 1 and 3`),
  ],
);

export const answers = pgTable(
  "answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    aiPass: boolean("ai_pass").notNull(),
    aiFeedback: text("ai_feedback"),
  },
  (t) => [
    unique("answers_attempt_question_unique").on(t.attemptId, t.questionId),
    index("answers_question_id_idx").on(t.questionId),
  ],
);

export const challenges = pgTable(
  "challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    readingId: uuid("reading_id")
      .notNull()
      .references(() => readings.id, { onDelete: "cascade" }),
    note: text("note").notNull(),
    status: challengeStatusEnum("status").notNull().default("open"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // Not in the v1 spec; added so the challenge queue can be ordered.
    createdAt: createdAt(),
  },
  (t) => [
    index("challenges_student_id_reading_id_idx").on(t.studentId, t.readingId),
    index("challenges_reading_id_status_idx").on(t.readingId, t.status),
  ],
);

// One row per link fetch a teacher starts from the add-reading form, for the
// per-teacher rate limit (see src/lib/link-rate-limit.ts). Rows older than a
// day are pruned as new ones are recorded.
export const linkFetchAttempts = pgTable(
  "link_fetch_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teacherId: uuid("teacher_id")
      .notNull()
      .references(() => teachers.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("link_fetch_attempts_teacher_id_created_at_idx").on(
      t.teacherId,
      t.createdAt,
    ),
  ],
);

// One row per teacher-started question generation (generate, regenerate
// all, regenerate one, sample preview), for the per-teacher rate limit (see
// src/lib/question-rate-limit.ts). Same shape and pruning as
// link_fetch_attempts. Student-triggered generations are not recorded here.
export const questionGenerationAttempts = pgTable(
  "question_generation_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teacherId: uuid("teacher_id")
      .notNull()
      .references(() => teachers.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("question_generation_attempts_teacher_id_created_at_idx").on(
      t.teacherId,
      t.createdAt,
    ),
  ],
);

// The claim that makes a student's question set generate at most once,
// however many requests open the reading at the same time (see
// src/lib/student-questions-core.ts). "pending" while one request calls the
// model; "done" once that set is saved, kept so a later claim can never
// start a second generation.
export const questionGenerations = pgTable(
  "question_generations",
  {
    readingId: uuid("reading_id")
      .notNull()
      .references(() => readings.id, { onDelete: "cascade" }),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    // Changes on every claim or takeover, so only the current holder can
    // finish or release it.
    claimToken: uuid("claim_token").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.readingId, t.studentId] }),
    index("question_generations_student_id_idx").on(t.studentId),
    check(
      "question_generations_status_check",
      sql`${t.status} in ('pending', 'done')`,
    ),
  ],
);

// Inferred types

export type Teacher = typeof teachers.$inferSelect;
export type NewTeacher = typeof teachers.$inferInsert;
export type Class = typeof classes.$inferSelect;
export type NewClass = typeof classes.$inferInsert;
export type Reading = typeof readings.$inferSelect;
export type NewReading = typeof readings.$inferInsert;
export type Question = typeof questions.$inferSelect;
export type NewQuestion = typeof questions.$inferInsert;
export type Student = typeof students.$inferSelect;
export type NewStudent = typeof students.$inferInsert;
export type Attempt = typeof attempts.$inferSelect;
export type NewAttempt = typeof attempts.$inferInsert;
export type Answer = typeof answers.$inferSelect;
export type NewAnswer = typeof answers.$inferInsert;
export type Challenge = typeof challenges.$inferSelect;
export type NewChallenge = typeof challenges.$inferInsert;
