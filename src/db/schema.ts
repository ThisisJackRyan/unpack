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
// Which home a signed-in account uses (see src/lib/account-role.ts). Null
// until the account makes the first-run choice on /welcome.
export const accountRoleEnum = pgEnum("account_role", [
  "teacher",
  "self_learner",
]);
// A self-learner's reading: in progress, passed (a passing try), or moved
// on (every try or every effort check used without a pass).
export const selfReadingStatusEnum = pgEnum("self_reading_status", [
  "in_progress",
  "passed",
  "moved_on",
]);
// closed: the student passed on their own while the challenge was open
// (auto-closed by the passing commit, see submit-answers-core.ts).
export const challengeStatusEnum = pgEnum("challenge_status", [
  "open",
  "approved",
  "denied",
  "closed",
]);

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// Tables

// One row per Clerk account: teachers and self-learners alike (the table
// keeps its first name). `role` picks the home; switching it in settings
// keeps every row under the account.
export const teachers = pgTable(
  "teachers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkUserId: text("clerk_user_id").notNull().unique(),
    name: text("name"),
    email: text("email").notNull(),
    plan: planEnum("plan").notNull().default("free"),
    createdAt: createdAt(),
    // Null until the first-run choice. Rows from before PR 13 were
    // backfilled to teacher.
    role: accountRoleEnum("role"),
    // When the account confirmed it is 13 or older, the first time it chose
    // self-learner. No birthdate is ever asked for or stored.
    ageConfirmedAt: timestamp("age_confirmed_at", { withTimezone: true }),
  },
  (t) => [
    // No self-learner without the age confirmation (COPPA): the role
    // statements in src/lib/account-role.ts set both in one statement, and
    // this is the backstop.
    check(
      "teachers_self_learner_age_check",
      sql`${t.role} is distinct from 'self_learner' or ${t.ageConfirmedAt} is not null`,
    ),
  ],
);

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
    // per-class uniqueness check ignores case, extra whitespace, and which
    // apostrophe was typed.
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
    // 3 tries, plus one per "one more try" a teacher grants (see
    // challenges.tries_allowed), so no fixed top. The conditional insert
    // in submit-answers-core.ts enforces the student's limit.
    check("attempts_try_number_check", sql`${t.tryNumber} >= 1`),
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
    // 1 for the first note. A student denied with one more try who fails
    // it again can send a new note: a new row, round + 1. Earlier rounds
    // are kept as they were decided.
    round: integer("round").notNull().default(1),
    note: text("note").notNull(),
    status: challengeStatusEnum("status").notNull().default("open"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // The teacher who accepted or denied it; null while open, and for an
    // auto-close.
    resolvedBy: uuid("resolved_by").references(() => teachers.id, {
      onDelete: "set null",
    }),
    // Set only by Deny with "Give one more try": the student's limits from
    // then on (tries used + 1, checks used + EXTRA_TRY_CHECKS). The latest
    // round that has them wins; with none, MAX_TRIES and
    // EFFORT_CHECK_LIMIT. Nothing is deleted: attempts, answers, and
    // effort_checks rows stay, and only the limits move.
    triesAllowed: integer("tries_allowed"),
    checksAllowed: integer("checks_allowed"),
    // Not in the v1 spec; added so the challenge queue can be ordered.
    createdAt: createdAt(),
  },
  (t) => [
    // One challenge per student, reading, and round. The insert in
    // src/lib/challenges-core.ts runs under the student's advisory lock
    // and is conditional (out of tries or checks, no pass, no open or
    // final challenge); this is the backstop that makes 20 parallel sends
    // save exactly one.
    unique("challenges_student_reading_round_unique").on(
      t.studentId,
      t.readingId,
      t.round,
    ),
    index("challenges_reading_id_status_idx").on(t.readingId, t.status),
    check("challenges_round_check", sql`${t.round} >= 1`),
    check(
      "challenges_grant_check",
      sql`(${t.triesAllowed} is null) = (${t.checksAllowed} is null) and (${t.triesAllowed} is null or ${t.status} = 'denied')`,
    ),
  ],
);

// One row per effort check a student starts (see
// src/lib/submit-answers-core.ts). It is two things at once:
// - the in-flight claim: unfinished (finished_at null) while one request
//   calls the model, so a second submit for the same student and reading
//   is told to wait, and
// - the cost guard: every row the model answered counts toward
//   EFFORT_CHECK_LIMIT per student per reading, including a reply we
//   couldn't use (which doesn't use up a try). A check that failed before
//   any reply (not set up, out of credits, an outage, a timeout) is marked
//   given_back: it doesn't count toward that limit, only toward a short
//   window that slows retries during an outage (see
//   src/lib/submit-answers-core.ts). Rows are kept, so the limit is for
//   all time.
// Only ids and times: no answer text.
export const effortChecks = pgTable(
  "effort_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    readingId: uuid("reading_id")
      .notNull()
      .references(() => readings.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // Null while running; pass or fail when an attempt was saved; error
    // when the model answered but no attempt was saved; given_back when
    // the model call failed with no reply.
    outcome: text("outcome"),
  },
  (t) => [
    index("effort_checks_student_id_reading_id_idx").on(t.studentId, t.readingId),
    index("effort_checks_reading_id_idx").on(t.readingId),
    check(
      "effort_checks_outcome_check",
      sql`${t.outcome} is null or ${t.outcome} in ('pass', 'fail', 'error', 'given_back')`,
    ),
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

// One row per model call made for a student's own question set (see
// src/lib/student-questions-core.ts): written in the same transaction as
// the claim (or stale takeover) that is about to call the model, and only
// then, so cached opens and throttled ones add nothing. created_at is set
// to the claim's claimed_at, so a call that ends without a response from
// the model (an outage, a bad key, a timeout) can find exactly its own row
// with its claim and mark it given_back. The "Try again" throttle counts
// these rows: every row toward STUDENT_GENERATION_WINDOW_LIMIT per student
// per reading per STUDENT_GENERATION_WINDOW_MINUTES (so an outage can't be
// hammered), and only rows not given back toward
// STUDENT_GENERATION_CALL_LIMIT for all time (the provider's fault doesn't
// use up the student's tries). Kept (the lifetime cap needs them) until
// the student or reading is deleted, or the teacher's "Let them try again"
// clears that student's rows for that reading
// (src/lib/student-question-reset.ts). Only ids, a flag, and a time.
export const studentQuestionCalls = pgTable(
  "student_question_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    readingId: uuid("reading_id")
      .notNull()
      .references(() => readings.id, { onDelete: "cascade" }),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    // True when the call ended without a response from the model: it
    // still counts toward the window, but not toward the lifetime limit.
    givenBack: boolean("given_back").notNull().default(false),
  },
  (t) => [
    index("student_question_calls_student_reading_created_at_idx").on(
      t.studentId,
      t.readingId,
      t.createdAt,
    ),
    index("student_question_calls_reading_id_idx").on(t.readingId),
  ],
);

// The one-time raise of a per-student reading's student set cap, from
// STUDENT_SETS_PER_READING_LIMIT (150) to STUDENT_SETS_RAISED_LIMIT (300),
// by its teacher (see src/lib/reading-cap.ts). One row per reading at
// most: the unique reading_id makes concurrent raises save exactly one,
// and is the log of who raised it and when. The student set claim reads
// to_limit from here. Teacher data, not student data.
export const readingCapRaises = pgTable(
  "reading_cap_raises",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    readingId: uuid("reading_id")
      .notNull()
      .unique()
      .references(() => readings.id, { onDelete: "cascade" }),
    teacherId: uuid("teacher_id")
      .notNull()
      .references(() => teachers.id, { onDelete: "cascade" }),
    fromLimit: integer("from_limit").notNull(),
    toLimit: integer("to_limit").notNull(),
    raisedAt: timestamp("raised_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("reading_cap_raises_teacher_id_idx").on(t.teacherId),
    check(
      "reading_cap_raises_limits_check",
      sql`${t.toLimit} > ${t.fromLimit}`,
    ),
  ],
);

// One row per counted join attempt per key, for the join rate limits (see
// src/lib/join-rate-limit.ts): an allowed attempt writes an "ip" row and a
// "code" row. key_hash is a hex digest, so no raw IP address (or typed
// code) is stored: a keyed hash (HMAC-SHA256 with a server secret) for an
// IP, plain SHA-256 for a code. Rows are deleted by the next join after the
// 10-minute window, so after a quiet period they can stay a while longer.
export const joinAttempts = pgTable(
  "join_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    keyKind: text("key_kind").notNull(),
    keyHash: text("key_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("join_attempts_key_created_at_idx").on(
      t.keyKind,
      t.keyHash,
      t.createdAt,
    ),
    // For the prune, which deletes expired rows of every key.
    index("join_attempts_created_at_idx").on(t.createdAt),
    check("join_attempts_key_kind_check", sql`${t.keyKind} in ('ip', 'code')`),
  ],
);

// Clerk accounts that were deleted (the user.deleted webhook), so a late
// user.created or user.updated delivery, or a first visit on a session
// that outlived the account, can't bring the account row back. Only a
// SHA-256 hash of the Clerk user id (see src/lib/deleted-accounts.ts),
// never the id, a name, or an email. Rows older than
// DELETED_ACCOUNT_RETENTION_DAYS are pruned by the next account delete
// (see docs/privacy.md).
export const deletedClerkUsers = pgTable(
  "deleted_clerk_users",
  {
    clerkUserHash: text("clerk_user_hash").primaryKey(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("deleted_clerk_users_deleted_at_idx").on(t.deletedAt)],
);

// Self-learner mode (see src/lib/self-readings-core.ts). Its own tables,
// never class or student rows, each scoped to the account and cascading
// from the teachers row, so the Clerk webhook's account delete removes all
// of it. No challenges: a self-learner moves on after the last try.

// One row per reading a self-learner starts. Rows are never deleted by the
// self-learner (only with the account), so the 5-per-7-days allowance
// counts these rows by created_at (see src/lib/self-allowance.ts), except
// those whose slot was given back: slot_released_at is set when a question
// write was attempted and failed and the reading still has no questions
// (never when no write was attempted, as at the question limit), and
// cleared when a later Try again takes the slot back.
// questions_claim_token / questions_claimed_at: the claim that makes the
// question set generate at most once at a time (see
// src/lib/self-questions-core.ts).
export const selfReadings = pgTable(
  "self_readings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => teachers.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sourceUrl: text("source_url"),
    bodyText: text("body_text").notNull(),
    gradeLevel: gradeLevelEnum("grade_level").notNull(),
    questionCount: integer("question_count").notNull().default(3),
    status: selfReadingStatusEnum("status").notNull().default("in_progress"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    questionsClaimToken: uuid("questions_claim_token"),
    questionsClaimedAt: timestamp("questions_claimed_at", { withTimezone: true }),
    slotReleasedAt: timestamp("slot_released_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("self_readings_account_id_created_at_idx").on(t.accountId, t.createdAt),
    check(
      "self_readings_question_count_check",
      sql`${t.questionCount} between 1 and 10`,
    ),
  ],
);

export const selfQuestions = pgTable(
  "self_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    readingId: uuid("reading_id")
      .notNull()
      .references(() => selfReadings.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    prompt: text("prompt").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("self_questions_reading_position_unique").on(t.readingId, t.position),
  ],
);

export const selfAttempts = pgTable(
  "self_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => teachers.id, { onDelete: "cascade" }),
    readingId: uuid("reading_id")
      .notNull()
      .references(() => selfReadings.id, { onDelete: "cascade" }),
    tryNumber: integer("try_number").notNull(),
    result: attemptResultEnum("result").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("self_attempts_reading_try_unique").on(t.readingId, t.tryNumber),
    index("self_attempts_account_id_idx").on(t.accountId),
    // MAX_TRIES (3): no one more try in self-learner mode.
    check("self_attempts_try_number_check", sql`${t.tryNumber} between 1 and 3`),
  ],
);

export const selfAnswers = pgTable(
  "self_answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => selfAttempts.id, { onDelete: "cascade" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => selfQuestions.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    aiPass: boolean("ai_pass").notNull(),
    aiFeedback: text("ai_feedback"),
  },
  (t) => [
    unique("self_answers_attempt_question_unique").on(t.attemptId, t.questionId),
    index("self_answers_question_id_idx").on(t.questionId),
  ],
);

// Same role as effort_checks: the in-flight claim and the cost guard
// (EFFORT_CHECK_LIMIT per reading, for all time). Only ids and times.
export const selfEffortChecks = pgTable(
  "self_effort_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => teachers.id, { onDelete: "cascade" }),
    readingId: uuid("reading_id")
      .notNull()
      .references(() => selfReadings.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outcome: text("outcome"),
  },
  (t) => [
    index("self_effort_checks_reading_id_idx").on(t.readingId),
    index("self_effort_checks_account_id_idx").on(t.accountId),
    check(
      "self_effort_checks_outcome_check",
      sql`${t.outcome} is null or ${t.outcome} in ('pass', 'fail', 'error', 'given_back')`,
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
export type EffortCheck = typeof effortChecks.$inferSelect;
export type ReadingCapRaise = typeof readingCapRaises.$inferSelect;
export type SelfReading = typeof selfReadings.$inferSelect;
