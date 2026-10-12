CREATE TABLE "mcp_tool_limits" (
	"server_id" text NOT NULL,
	"tool" text NOT NULL,
	"level" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tool_limits_server_id_tool_pk" PRIMARY KEY("server_id","tool")
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "tool_grant" jsonb;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD COLUMN "verdict" text;--> statement-breakpoint
ALTER TABLE "mcp_tool_limits" ADD CONSTRAINT "mcp_tool_limits_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_calls_run_idx" ON "tool_calls" USING btree ("run_id");