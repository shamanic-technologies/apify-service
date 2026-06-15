CREATE TABLE IF NOT EXISTS "lead_emissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"company_domain" text,
	"first_name" text,
	"last_name" text,
	"brand_ids" uuid[],
	"emitted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_emissions_org_campaign_idx" ON "lead_emissions" USING btree ("org_id","campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lead_emissions_key_idx" ON "lead_emissions" USING btree ("org_id","campaign_id","company_domain","first_name","last_name");