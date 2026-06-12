import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// ─── Search ────────────────────────────────────────────────────────────────

// Shared filter fields — reused by /search and /search/count.
const filterFields = {
  titles: z.array(z.string()).optional(),
  seniorities: z.array(z.string()).optional(),
  functions: z.array(z.string()).optional(),
  locationCountries: z.array(z.string()).optional(),
  locationStates: z.array(z.string()).optional(),
  locationCities: z.array(z.string()).optional(),
  companyNames: z.array(z.string()).optional(),
  industries: z.array(z.string()).optional(),
  companyDomains: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  // Rich filters (pipelinelabs-backed). See GET /search/reference for vocab.
  companySizes: z.array(z.string()).optional(),
  revenueRanges: z.array(z.string()).optional(),
  fundingStages: z.array(z.string()).optional(),
  technologies: z.array(z.string()).optional(),
  employeeMin: z.number().int().positive().optional(),
  employeeMax: z.number().int().positive().optional(),
} as const;

export const SearchRequestSchema = z
  .object({
    ...filterFields,
    limit: z.number().int().min(1).max(1000),
    // Resume position for pagination past the first page (pipelinelabs only).
    offset: z.number().int().min(0).optional(),
  })
  .openapi("SearchRequest");

// Count: same filters, no paging. Free match-count (no credits, no persistence).
export const SearchCountRequestSchema = z
  .object({ ...filterFields })
  .openapi("SearchCountRequest");

export const SearchCountResponseSchema = z
  .object({ totalMatched: z.number() })
  .openapi("SearchCountResponse");

export const FiltersPromptResponseSchema = z
  .object({ prompt: z.string(), schemaVersion: z.string() })
  .openapi("FiltersPromptResponse");

export const ReferenceResponseSchema = z
  .object({
    industries: z.array(z.string()),
    seniorities: z.array(z.string()),
    functions: z.array(z.string()),
    companySizes: z.array(z.string()),
    revenueRanges: z.array(z.string()),
    fundingStages: z.array(z.string()),
  })
  .openapi("ReferenceResponse");

// ─── Resolve ──────────────────────────────────────────────────────────────

export const LeadInputSchema = z
  .object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    companyDomain: z.string().min(1),
  })
  .openapi("LeadInput");

export const ResolveRequestSchema = z
  .object({
    leads: z.array(LeadInputSchema).min(1).max(100),
    // OFF by default — when true, allow clearpath pattern-guessed (inferred) emails.
    includeInferred: z.boolean().optional(),
  })
  .openapi("ResolveRequest");

// ─── Lead (response) ─────────────────────────────────────────────────────────

export const LeadSchema = z
  .object({
    firstName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
    fullName: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    seniority: z.string().nullable().optional(),
    email: z.string(),
    emailStatus: z.string(),
    source: z.enum(["pipelinelabs", "microworlds", "clearpath"]),
    isCatchAll: z.boolean(),
    isInferred: z.boolean(),
    linkedinUrl: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    companyName: z.string().nullable().optional(),
    companyDomain: z.string().nullable().optional(),
    companyIndustry: z.string().nullable().optional(),
    companySize: z.number().nullable().optional(),
    companyLinkedinUrl: z.string().nullable().optional(),
  })
  .openapi("Lead");

export const SearchResponseSchema = z
  .object({
    searchId: z.string(),
    leadCount: z.number(),
    verifiedCount: z.number(),
    // Total matchable across the filter set (pipelinelabs probe), independent
    // of the returned page — lets the caller tell whether more results exist.
    totalMatched: z.number().optional(),
    hasMore: z.boolean().optional(),
    // Offset to pass back on the next /search call to fetch the next page.
    nextOffset: z.number().optional(),
    leads: z.array(LeadSchema),
  })
  .openapi("SearchResponse");

export const ResolveResponseSchema = z
  .object({
    searchId: z.string(),
    requested: z.number(),
    resolvedCount: z.number(),
    leads: z.array(LeadSchema),
  })
  .openapi("ResolveResponse");

export type SearchRequest = z.infer<typeof SearchRequestSchema>;
export type ResolveRequest = z.infer<typeof ResolveRequestSchema>;
export type Lead = z.infer<typeof LeadSchema>;

// ─── OpenAPI paths ─────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/search",
  summary: "Search for verified-email leads via the Apify waterfall (pipelinelabs + microworlds).",
  request: {
    body: { content: { "application/json": { schema: SearchRequestSchema } } },
  },
  responses: {
    200: {
      description: "Verified leads",
      content: { "application/json": { schema: SearchResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/resolve",
  summary: "Resolve verified emails for known leads (name + domain) via the waterfall.",
  request: {
    body: { content: { "application/json": { schema: ResolveRequestSchema } } },
  },
  responses: {
    200: {
      description: "Resolved leads",
      content: { "application/json": { schema: ResolveResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/search/count",
  summary:
    "Count people matching a filter set — zero credit spend, zero persistence (pipelinelabs countOnly).",
  request: {
    body: { content: { "application/json": { schema: SearchCountRequestSchema } } },
  },
  responses: {
    200: {
      description: "Match count",
      content: { "application/json": { schema: SearchCountResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/search/filters-prompt",
  summary: "Stable, versioned description of apify's accepted search filters (for LLM callers).",
  responses: {
    200: {
      description: "Filter-shape prompt + schema version",
      content: { "application/json": { schema: FiltersPromptResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/search/reference",
  summary: "Accepted-value vocabulary for the enum filters (industries, seniorities, etc.).",
  responses: {
    200: {
      description: "Accepted filter vocabularies",
      content: { "application/json": { schema: ReferenceResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/searches/{runId}",
  summary: "Fetch stored leads for a run.",
  responses: {
    200: {
      description: "Leads for the run",
      content: { "application/json": { schema: z.object({ leads: z.array(LeadSchema) }) } },
    },
  },
});
