CREATE TYPE "public"."account_role" AS ENUM('teacher', 'self_learner');--> statement-breakpoint
CREATE TYPE "public"."self_reading_status" AS ENUM('in_progress', 'passed', 'moved_on');--> statement-breakpoint
CREATE TABLE "self_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"text" text NOT NULL,
	"ai_pass" boolean NOT NULL,
	"ai_feedback" text,
	CONSTRAINT "self_answers_attempt_question_unique" UNIQUE("attempt_id","question_id")
);
--> statement-breakpoint
CREATE TABLE "self_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"reading_id" uuid NOT NULL,
	"try_number" integer NOT NULL,
	"result" "attempt_result" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "self_attempts_reading_try_unique" UNIQUE("reading_id","try_number"),
	CONSTRAINT "self_attempts_try_number_check" CHECK ("self_attempts"."try_number" between 1 and 3)
);
--> statement-breakpoint
CREATE TABLE "self_effort_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"reading_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text,
	CONSTRAINT "self_effort_checks_outcome_check" CHECK ("self_effort_checks"."outcome" is null or "self_effort_checks"."outcome" in ('pass', 'fail', 'error'))
);
--> statement-breakpoint
CREATE TABLE "self_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reading_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"prompt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "self_questions_reading_position_unique" UNIQUE("reading_id","position")
);
--> statement-breakpoint
CREATE TABLE "self_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"title" text NOT NULL,
	"source_url" text,
	"body_text" text NOT NULL,
	"grade_level" "grade_level" NOT NULL,
	"question_count" integer DEFAULT 3 NOT NULL,
	"status" "self_reading_status" DEFAULT 'in_progress' NOT NULL,
	"finished_at" timestamp with time zone,
	"questions_claim_token" uuid,
	"questions_claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "self_readings_question_count_check" CHECK ("self_readings"."question_count" between 1 and 10)
);
--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN "role" "account_role";--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN "age_confirmed_at" timestamp with time zone;--> statement-breakpoint
-- Backfill (added by hand to the generated file): every account from before
-- self-learner mode is a teacher, so existing teachers keep working with no
-- first-run choice. New rows start with no role.
UPDATE "teachers" SET "role" = 'teacher' WHERE "role" IS NULL;--> statement-breakpoint
ALTER TABLE "self_answers" ADD CONSTRAINT "self_answers_attempt_id_self_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."self_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_answers" ADD CONSTRAINT "self_answers_question_id_self_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."self_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_attempts" ADD CONSTRAINT "self_attempts_account_id_teachers_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."teachers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_attempts" ADD CONSTRAINT "self_attempts_reading_id_self_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."self_readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_effort_checks" ADD CONSTRAINT "self_effort_checks_account_id_teachers_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."teachers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_effort_checks" ADD CONSTRAINT "self_effort_checks_reading_id_self_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."self_readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_questions" ADD CONSTRAINT "self_questions_reading_id_self_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."self_readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_readings" ADD CONSTRAINT "self_readings_account_id_teachers_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."teachers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "self_answers_question_id_idx" ON "self_answers" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "self_attempts_account_id_idx" ON "self_attempts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "self_effort_checks_reading_id_idx" ON "self_effort_checks" USING btree ("reading_id");--> statement-breakpoint
CREATE INDEX "self_effort_checks_account_id_idx" ON "self_effort_checks" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "self_readings_account_id_created_at_idx" ON "self_readings" USING btree ("account_id","created_at");--> statement-breakpoint
ALTER TABLE "teachers" ADD CONSTRAINT "teachers_self_learner_age_check" CHECK ("teachers"."role" is distinct from 'self_learner' or "teachers"."age_confirmed_at" is not null);