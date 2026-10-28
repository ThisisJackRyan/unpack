CREATE TABLE "deleted_clerk_users" (
	"clerk_user_hash" text PRIMARY KEY NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"clerk_deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "effort_checks" DROP CONSTRAINT "effort_checks_outcome_check";--> statement-breakpoint
ALTER TABLE "self_effort_checks" DROP CONSTRAINT "self_effort_checks_outcome_check";--> statement-breakpoint
ALTER TABLE "self_readings" ADD COLUMN "slot_released_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "deleted_clerk_users_clerk_deleted_at_idx" ON "deleted_clerk_users" USING btree ("clerk_deleted_at");--> statement-breakpoint
ALTER TABLE "effort_checks" ADD CONSTRAINT "effort_checks_outcome_check" CHECK ("effort_checks"."outcome" is null or "effort_checks"."outcome" in ('pass', 'fail', 'error', 'given_back'));--> statement-breakpoint
ALTER TABLE "self_effort_checks" ADD CONSTRAINT "self_effort_checks_outcome_check" CHECK ("self_effort_checks"."outcome" is null or "self_effort_checks"."outcome" in ('pass', 'fail', 'error', 'given_back'));