CREATE TABLE "followups" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"note" text NOT NULL,
	"recipe_id" text,
	"origin" text,
	"chain_id" text NOT NULL,
	"empty_wakes" integer DEFAULT 0 NOT NULL,
	"booked_in_run_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_id" text,
	"cancelled_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fired_at" timestamp with time zone,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "followups" ADD CONSTRAINT "followups_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followups" ADD CONSTRAINT "followups_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "followups_agent_idx" ON "followups" USING btree ("agent_id","status","due_at");--> statement-breakpoint
CREATE INDEX "followups_due_idx" ON "followups" USING btree ("status","due_at");