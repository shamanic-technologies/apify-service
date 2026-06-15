import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * One row per /search or /resolve request. Audit + stats.
 */
export const leadSearches = pgTable(
  "lead_searches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    runId: text("run_id"),
    brandIds: uuid("brand_ids").array(),
    campaignId: text("campaign_id"),
    featureSlug: text("feature_slug"),
    workflowSlug: text("workflow_slug"),
    mode: text("mode").notNull(), // "search" | "resolve"
    requestParams: jsonb("request_params"),
    leadCount: integer("lead_count").notNull().default(0),
    verifiedCount: integer("verified_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("lead_searches_org_idx").on(t.orgId),
    runIdx: index("lead_searches_run_idx").on(t.runId),
    campaignIdx: index("lead_searches_campaign_idx").on(t.campaignId),
  })
);

/**
 * One row per resolved lead (verified or inferred email). Doubles as the
 * 12-month cache: a (org, company_domain, first, last) tuple is resolved once.
 */
export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    runId: text("run_id"),
    searchId: uuid("search_id"),
    brandIds: uuid("brand_ids").array(),
    campaignId: text("campaign_id"),
    featureSlug: text("feature_slug"),
    workflowSlug: text("workflow_slug"),
    // Person
    firstName: text("first_name"),
    lastName: text("last_name"),
    fullName: text("full_name"),
    title: text("title"),
    seniority: text("seniority"),
    linkedinUrl: text("linkedin_url"),
    city: text("city"),
    state: text("state"),
    country: text("country"),
    // Email
    email: text("email"),
    emailStatus: text("email_status"), // "deliverable" | "verified" | "inferred" | "unknown"
    source: text("source"), // "pipelinelabs" | "microworlds" | "clearpath"
    isCatchAll: boolean("is_catch_all").notNull().default(false),
    isInferred: boolean("is_inferred").notNull().default(false),
    // Company
    companyName: text("company_name"),
    companyDomain: text("company_domain"),
    companyIndustry: text("company_industry"),
    companySize: integer("company_size"),
    companyLinkedinUrl: text("company_linkedin_url"),
    responseRaw: jsonb("response_raw"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("leads_org_idx").on(t.orgId),
    runIdx: index("leads_run_idx").on(t.runId),
    searchIdx: index("leads_search_idx").on(t.searchId),
    emailIdx: index("leads_email_idx").on(t.email),
    campaignIdx: index("leads_campaign_idx").on(t.campaignId),
    // Cache key: one resolved lead per (org, domain, name).
    cacheIdx: uniqueIndex("leads_cache_idx").on(
      t.orgId,
      t.companyDomain,
      t.firstName,
      t.lastName
    ),
  })
);

/**
 * Per-campaign emission log: one row per (org, person, campaign) the moment a
 * lead is HANDED BACK to the caller for that campaign. The source of truth for
 * "already served this person to this campaign" — distinct from `leads` (the
 * org-scoped resolved-email cache, one row per person regardless of campaign).
 *
 * Two responsibilities ride on it:
 *   1. No-repeat — exclude already-emitted people from future /search results so
 *      apify never hands the same person back twice for the same campaignId.
 *   2. Saturation-stop — a /search page yielding zero FRESH (not-already-emitted)
 *      distinct leads is terminal, so `done` reflects fresh-distinct exhaustion
 *      rather than the inflated pipelinelabs count-probe.
 *
 * `brand_ids` is carried now (not used here) so a future per-brand 6-month window
 * (human-service#36) can plug in without a migration. Person identity is
 * (company_domain, first_name, last_name) — same key family as `leads_cache_idx`.
 */
export const leadEmissions = pgTable(
  "lead_emissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    campaignId: text("campaign_id").notNull(),
    companyDomain: text("company_domain"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    brandIds: uuid("brand_ids").array(),
    emittedAt: timestamp("emitted_at").notNull().defaultNow(),
  },
  (t) => ({
    orgCampaignIdx: index("lead_emissions_org_campaign_idx").on(
      t.orgId,
      t.campaignId
    ),
    // No-repeat key: one emission per (org, campaign, person).
    emissionKeyIdx: uniqueIndex("lead_emissions_key_idx").on(
      t.orgId,
      t.campaignId,
      t.companyDomain,
      t.firstName,
      t.lastName
    ),
  })
);
