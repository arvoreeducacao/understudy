ALTER TABLE "approvals" ADD COLUMN "answered_via" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "slack_messages" jsonb;