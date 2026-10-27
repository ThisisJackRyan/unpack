CREATE TABLE "effort_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"reading_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text,
	CONSTRAINT "effort_checks_outcome_check" CHECK ("effort_checks"."outcome" is null or "effort_checks"."outcome" in ('pass', 'fail', 'error'))
);
--> statement-breakpoint
DROP INDEX "challenges_student_id_reading_id_idx";--> statement-breakpoint
ALTER TABLE "effort_checks" ADD CONSTRAINT "effort_checks_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "effort_checks" ADD CONSTRAINT "effort_checks_reading_id_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "effort_checks_student_id_reading_id_idx" ON "effort_checks" USING btree ("student_id","reading_id");--> statement-breakpoint
CREATE INDEX "effort_checks_reading_id_idx" ON "effort_checks" USING btree ("reading_id");--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_student_id_reading_id_unique" UNIQUE("student_id","reading_id");