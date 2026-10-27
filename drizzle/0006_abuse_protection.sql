CREATE TABLE "student_question_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reading_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "student_question_calls" ADD CONSTRAINT "student_question_calls_reading_id_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_question_calls" ADD CONSTRAINT "student_question_calls_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "student_question_calls_student_reading_created_at_idx" ON "student_question_calls" USING btree ("student_id","reading_id","created_at");--> statement-breakpoint
CREATE INDEX "student_question_calls_reading_id_idx" ON "student_question_calls" USING btree ("reading_id");