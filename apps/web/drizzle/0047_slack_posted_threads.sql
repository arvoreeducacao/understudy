CREATE TABLE "slack_posted_threads" (
	"channel" text NOT NULL,
	"thread_ts" text NOT NULL,
	"agent_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_posted_threads_channel_thread_ts_pk" PRIMARY KEY("channel","thread_ts")
);
--> statement-breakpoint
ALTER TABLE "slack_posted_threads" ADD CONSTRAINT "slack_posted_threads_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_posted_threads_expires_idx" ON "slack_posted_threads" USING btree ("expires_at");