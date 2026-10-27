CREATE TABLE "reading_cap_raises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reading_id" uuid NOT NULL,
	"teacher_id" uuid NOT NULL,
	"from_limit" integer NOT NULL,
	"to_limit" integer NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reading_cap_raises_reading_id_unique" UNIQUE("reading_id"),
	CONSTRAINT "reading_cap_raises_limits_check" CHECK ("reading_cap_raises"."to_limit" > "reading_cap_raises"."from_limit")
);
--> statement-breakpoint
ALTER TABLE "student_question_calls" ADD COLUMN "given_back" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reading_cap_raises" ADD CONSTRAINT "reading_cap_raises_reading_id_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_cap_raises" ADD CONSTRAINT "reading_cap_raises_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reading_cap_raises_teacher_id_idx" ON "reading_cap_raises" USING btree ("teacher_id");