ALTER TABLE "agents" ADD COLUMN "approval_policy" jsonb DEFAULT '{"mode":"on-miss","allow":[],"fallback":"wait"}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "agents" SET "approval_policy" = jsonb_set("approval_policy", '{fallback}', '"wait"') WHERE coalesce("approval_policy"->>'fallback', '') NOT IN ('wait', 'deny');
