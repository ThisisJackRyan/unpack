ALTER TABLE "readings" ADD COLUMN "body_trimmed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "self_readings" ADD COLUMN "body_trimmed" boolean DEFAULT false NOT NULL;