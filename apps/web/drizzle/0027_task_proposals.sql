CREATE TABLE "task_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"recipe" jsonb NOT NULL,
	"cron" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"reason" text NOT NULL,
	"origin" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"recipe_id" text,
	"slack_channel" text,
	"slack_ts" text,
	"answered_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "proposal_id" text;--> statement-breakpoint
ALTER TABLE "task_proposals" ADD CONSTRAINT "task_proposals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_proposals" ADD CONSTRAINT "task_proposals_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_proposals_agent_idx" ON "task_proposals" USING btree ("agent_id","status");