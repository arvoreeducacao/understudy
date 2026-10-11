CREATE TABLE "agent_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"kind" text NOT NULL,
	"address" text NOT NULL,
	"allowed_senders" text,
	"unknown_senders" text DEFAULT 'hold' NOT NULL,
	"secret" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_routes" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"peer" text NOT NULL,
	"peer_name" text,
	"trusted" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"last_message_id" text,
	"references" text DEFAULT '' NOT NULL,
	"held" jsonb,
	"pending_text" text DEFAULT '' NOT NULL,
	"pending_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pending_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbound_queue" ADD COLUMN "channel_thread_id" text;--> statement-breakpoint
ALTER TABLE "agent_channels" ADD CONSTRAINT "agent_channels_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_routes" ADD CONSTRAINT "channel_routes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_routes" ADD CONSTRAINT "channel_routes_thread_id_channel_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."channel_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_threads" ADD CONSTRAINT "channel_threads_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_threads" ADD CONSTRAINT "channel_threads_channel_id_agent_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."agent_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_channels_address_idx" ON "agent_channels" USING btree ("kind","address");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_channels_agent_kind_idx" ON "agent_channels" USING btree ("agent_id","kind");--> statement-breakpoint
CREATE INDEX "channel_threads_channel_idx" ON "channel_threads" USING btree ("channel_id","peer","updated_at");--> statement-breakpoint
CREATE INDEX "channel_threads_pending_idx" ON "channel_threads" USING btree ("pending_since");