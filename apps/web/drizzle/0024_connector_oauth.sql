ALTER TABLE "mcp_servers" ADD COLUMN "oauth_client" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_tokens" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_state" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_verifier" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_oauth_state_unique" UNIQUE("oauth_state");