import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// ─── Search ────────────────────────────────────────────────────────────────

export const SearchRequestSchema = z
  .object({
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
    employeeMin: z.number().int().positive().optional(),
    employeeMax: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(1000),
  })
  .openapi("SearchRequest");

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
