CREATE TABLE "slack_asker_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"asked_by" text NOT NULL,
	"channel" text NOT NULL,
	"thread_ts" text,
	"slack_user" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_asker_threads" ADD CONSTRAINT "slack_asker_threads_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_asker_threads" ADD CONSTRAINT "slack_asker_threads_asked_by_user_id_fk" FOREIGN KEY ("asked_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_asker_threads_thread_idx" ON "slack_asker_threads" USING btree ("channel","thread_ts");--> statement-breakpoint
CREATE INDEX "slack_asker_threads_expires_idx" ON "slack_asker_threads" USING btree ("expires_at");