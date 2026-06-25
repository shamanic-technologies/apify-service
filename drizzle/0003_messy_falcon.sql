CREATE TABLE IF NOT EXISTS "apify_audience_refinements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audience_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"iteration" integer NOT NULL,
	"segment_text" text,
	"feedback" text,
	"filters" jsonb,
	"count" integer,
	"llm_raw" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "apify_audiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"brand_id" text,
	"filters" jsonb NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"schema_version" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apify_audience_refinements_audience_idx" ON "apify_audience_refinements" USING btree ("audience_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apify_audiences_org_idx" ON "apify_audiences" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apify_audiences_brand_idx" ON "apify_audiences" USING btree ("brand_id");