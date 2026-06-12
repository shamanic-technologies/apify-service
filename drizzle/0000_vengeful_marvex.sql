CREATE TABLE IF NOT EXISTS "lead_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"run_id" text,
	"brand_ids" uuid[],
	"campaign_id" text,
	"feature_slug" text,
	"workflow_slug" text,
	"mode" text NOT NULL,
	"request_params" jsonb,
	"lead_count" integer DEFAULT 0 NOT NULL,
	"verified_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"run_id" text,
	"search_id" uuid,
	"brand_ids" uuid[],
	"campaign_id" text,
	"feature_slug" text,
	"workflow_slug" text,
	"first_name" text,
	"last_name" text,
	"full_name" text,
	"title" text,
	"seniority" text,
	"linkedin_url" text,
	"city" text,
	"state" text,
	"country" text,
	"email" text,
	"email_status" text,
	"source" text,
	"is_catch_all" boolean DEFAULT false NOT NULL,
	"is_inferred" boolean DEFAULT false NOT NULL,
	"company_name" text,
	"company_domain" text,
	"company_industry" text,
	"company_size" integer,
	"company_linkedin_url" text,
	"response_raw" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_searches_org_idx" ON "lead_searches" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_searches_run_idx" ON "lead_searches" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_searches_campaign_idx" ON "lead_searches" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_org_idx" ON "leads" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_run_idx" ON "leads" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_search_idx" ON "leads" USING btree ("search_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_email_idx" ON "leads" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_campaign_idx" ON "leads" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "leads_cache_idx" ON "leads" USING btree ("org_id","company_domain","first_name","last_name");