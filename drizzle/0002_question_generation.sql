CREATE TABLE "question_generation_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_generations" (
	"reading_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claim_token" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_generations_reading_id_student_id_pk" PRIMARY KEY("reading_id","student_id"),
	CONSTRAINT "question_generations_status_check" CHECK ("question_generations"."status" in ('pending', 'done'))
);
--> statement-breakpoint
ALTER TABLE "question_generation_attempts" ADD CONSTRAINT "question_generation_attempts_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_generations" ADD CONSTRAINT "question_generations_reading_id_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_generations" ADD CONSTRAINT "question_generations_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_generation_attempts_teacher_id_created_at_idx" ON "question_generation_attempts" USING btree ("teacher_id","created_at");--> statement-breakpoint
CREATE INDEX "question_generations_student_id_idx" ON "question_generations" USING btree ("student_id");--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_reading_student_position_unique" UNIQUE NULLS NOT DISTINCT("reading_id","student_id","position");