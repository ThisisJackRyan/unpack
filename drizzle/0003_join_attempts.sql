CREATE TABLE "join_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_kind" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "join_attempts_key_kind_check" CHECK ("join_attempts"."key_kind" in ('ip', 'code'))
);
--> statement-breakpoint
CREATE INDEX "join_attempts_key_created_at_idx" ON "join_attempts" USING btree ("key_kind","key_hash","created_at");--> statement-breakpoint
CREATE INDEX "join_attempts_created_at_idx" ON "join_attempts" USING btree ("created_at");