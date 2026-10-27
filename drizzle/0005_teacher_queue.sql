ALTER TYPE "public"."challenge_status" ADD VALUE 'closed';--> statement-breakpoint
ALTER TABLE "challenges" DROP CONSTRAINT "challenges_student_id_reading_id_unique";--> statement-breakpoint
ALTER TABLE "attempts" DROP CONSTRAINT "attempts_try_number_check";--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "round" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "resolved_by" uuid;--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "tries_allowed" integer;--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "checks_allowed" integer;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_resolved_by_teachers_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."teachers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_student_reading_round_unique" UNIQUE("student_id","reading_id","round");--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_try_number_check" CHECK ("attempts"."try_number" >= 1);--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_round_check" CHECK ("challenges"."round" >= 1);--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_grant_check" CHECK (("challenges"."tries_allowed" is null) = ("challenges"."checks_allowed" is null) and ("challenges"."tries_allowed" is null or "challenges"."status" = 'denied'));