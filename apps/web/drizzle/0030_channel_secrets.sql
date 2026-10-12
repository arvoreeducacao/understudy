CREATE TABLE "channel_secrets" (
	"channel_id" text NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_secrets_channel_id_name_pk" PRIMARY KEY("channel_id","name")
);
--> statement-breakpoint
ALTER TABLE "channel_secrets" ADD CONSTRAINT "channel_secrets_channel_id_agent_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."agent_channels"("id") ON DELETE cascade ON UPDATE no action;