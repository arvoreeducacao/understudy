ALTER TABLE "agent_messages" ADD COLUMN "audience_id" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "audience_id" text;--> statement-breakpoint
ALTER TABLE "followups" ADD COLUMN "asked_by" text;--> statement-breakpoint
ALTER TABLE "room_participants" ADD COLUMN "follow_up_asked_by" text;