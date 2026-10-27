CREATE TABLE "link_fetch_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "link_fetch_attempts" ADD CONSTRAINT "link_fetch_attempts_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "link_fetch_attempts_teacher_id_created_at_idx" ON "link_fetch_attempts" USING btree ("teacher_id","created_at");