import { Router, Response } from "express";
import { and, eq, gte } from "drizzle-orm";
import { db } from "../db/index.js";
import { leadSearches, leads as leadsTable } from "../db/schema.js";
import { serviceAuth, AuthenticatedRequest } from "../middleware/auth.js";
import {
  SearchRequestSchema,
  ResolveRequestSchema,
  SearchCountRequestSchema,
} from "../schemas.js";
import { getPlatformKey } from "../lib/keys-client.js";
import { createRun, updateRun, IdentityHeaders, RunCost } from "../lib/runs-client.js";
import {
  COST_NAME_BY_SOURCE,
  provisionAndAuthorize,
  actualizeAndCancel,
} from "../lib/cost-tracking.js";
import {
  searchVerifiedLeads,
  resolveEmails,
  countMatches,
  NormalizedLead,
  LeadInput,
} from "../lib/waterfall.js";
import {
  buildFiltersPromptText,
  FILTERS_SCHEMA_VERSION,
  filterCatalog,
} from "../lib/filter-catalog.js";

const router = Router();

const SERVICE_NAME = "apify-service";
const CACHE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 12 months

function identityFromReq(req: AuthenticatedRequest): IdentityHeaders {
  return {
    orgId: req.orgId!,
    userId: req.userId,
    runId: req.runId,
    brandId: req.brandId,
    campaignId: req.campaignId,
    featureSlug: req.featureSlug,
    workflowSlug: req.workflowSlug,
  };
}

/** Map a normalized lead + request context to a DB row. */
function toLeadRow(
  req: AuthenticatedRequest,
  runId: string | undefined,
  searchId: string,
  l: NormalizedLead
) {
  return {
    orgId: req.orgId!,
    runId: runId ?? null,
    searchId,
    brandIds: req.brandIds ?? null,
    campaignId: req.campaignId ?? null,
    featureSlug: req.featureSlug ?? null,
    workflowSlug: req.workflowSlug ?? null,
    firstName: l.firstName ?? null,
    lastName: l.lastName ?? null,
    fullName: l.fullName ?? null,
    title: l.title ?? null,
    seniority: l.seniority ?? null,
    linkedinUrl: l.linkedinUrl ?? null,
    city: l.city ?? null,
    state: l.state ?? null,
    country: l.country ?? null,
    email: l.email,
    emailStatus: l.emailStatus,
    source: l.source,
    isCatchAll: l.isCatchAll,
    isInferred: l.isInferred,
    companyName: l.companyName ?? null,
    companyDomain: l.companyDomain ?? null,
    companyIndustry: l.companyIndustry ?? null,
    companySize: l.companySize ?? null,
    companyLinkedinUrl: l.companyLinkedinUrl ?? null,
    responseRaw: l.raw,
  };
}

/** Serialize a stored row or normalized lead to the API Lead shape. */
function toApiLead(l: NormalizedLead) {
  return {
    firstName: l.firstName ?? null,
    lastName: l.lastName ?? null,
    fullName: l.fullName ?? null,
    title: l.title ?? null,
    seniority: l.seniority ?? null,
    email: l.email,
    emailStatus: l.emailStatus,
    source: l.source,
    isCatchAll: l.isCatchAll,
    isInferred: l.isInferred,
    linkedinUrl: l.linkedinUrl ?? null,
    city: l.city ?? null,
    state: l.state ?? null,
    country: l.country ?? null,
    companyName: l.companyName ?? null,
    companyDomain: l.companyDomain ?? null,
    companyIndustry: l.companyIndustry ?? null,
    companySize: l.companySize ?? null,
    companyLinkedinUrl: l.companyLinkedinUrl ?? null,
  };
}

// ─── POST /search ────────────────────────────────────────────────────────────

router.post("/search", serviceAuth, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = SearchRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }
  const filters = parsed.data;
  const identity = identityFromReq(req);

  const token = await getPlatformKey("apify", {
    callerMethod: "POST",
    callerPath: "/search",
  });

  const run = await createRun({
    orgId: req.orgId!,
    userId: req.userId,
    brandId: req.brandId,
    campaignId: req.campaignId,
    featureSlug: req.featureSlug,
    workflowSlug: req.workflowSlug,
    parentRunId: req.runId,
    serviceName: SERVICE_NAME,
    taskName: "search",
  });
  const runIdentity: IdentityHeaders = { ...identity, runId: run.id };

  try {
    // PROVISION worst-case (both actors may each return `limit`) + AUTHORIZE,
    // BEFORE any Apify spend. Fail-loud if a cost name isn't declarable.
    const provisioned = await provisionAndAuthorize(
      run.id,
      [
        { costName: COST_NAME_BY_SOURCE.pipelinelabs, quantity: filters.limit },
        { costName: COST_NAME_BY_SOURCE.microworlds, quantity: filters.limit },
      ],
      `apify-service search (${filters.limit} leads)`,
      runIdentity
    );

    const { leads, totalMatched } = await searchVerifiedLeads(token, filters);

    // Paging signals (gaps 2 + 3). The cursor advances over the pipelinelabs
    // stream by the requested page size; more exist if the total exceeds it.
    const offsetBase = filters.offset ?? 0;
    const consumed = offsetBase + filters.limit;
    const hasMore = totalMatched > consumed;
    const nextOffset = hasMore ? consumed : undefined;

    const [searchRow] = await db
      .insert(leadSearches)
      .values({
        orgId: req.orgId!,
        runId: run.id,
        brandIds: req.brandIds ?? null,
        campaignId: req.campaignId ?? null,
        featureSlug: req.featureSlug ?? null,
        workflowSlug: req.workflowSlug ?? null,
        mode: "search",
        requestParams: filters,
        leadCount: leads.length,
        verifiedCount: leads.length,
      })
      .returning();

    if (leads.length > 0) {
      await db
        .insert(leadsTable)
        .values(leads.map((l) => toLeadRow(req, run.id, searchRow.id, l)))
        .onConflictDoNothing({
          target: [leadsTable.orgId, leadsTable.companyDomain, leadsTable.firstName, leadsTable.lastName],
        });
    }

    // ACTUALIZE per-actor real counts + cancel the provisioned holds.
    await actualizeAndCancel(run.id, leads, provisioned, runIdentity);

    await updateRun(run.id, "completed", runIdentity);

    return res.json({
      searchId: searchRow.id,
      leadCount: leads.length,
      verifiedCount: leads.length,
      totalMatched,
      hasMore,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
      leads: leads.map(toApiLead),
    });
  } catch (err) {
    await updateRun(run.id, "failed", runIdentity).catch((e) =>
      console.error("[apify-service] failed to mark run failed:", e)
    );
    throw err;
  }
});

// ─── POST /resolve ───────────────────────────────────────────────────────────

router.post("/resolve", serviceAuth, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = ResolveRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }
  const { leads: inputs, includeInferred } = parsed.data;
  const identity = identityFromReq(req);

  const token = await getPlatformKey("apify", {
    callerMethod: "POST",
    callerPath: "/resolve",
  });

  const run = await createRun({
    orgId: req.orgId!,
    userId: req.userId,
    brandId: req.brandId,
    campaignId: req.campaignId,
    featureSlug: req.featureSlug,
    workflowSlug: req.workflowSlug,
    parentRunId: req.runId,
    serviceName: SERVICE_NAME,
    taskName: "resolve",
  });
  const runIdentity: IdentityHeaders = { ...identity, runId: run.id };

  try {
    // 12-month cache: don't re-resolve / re-bill a lead already resolved for this org.
    const cutoff = new Date(Date.now() - CACHE_MAX_AGE_MS);
    const cachedHits: NormalizedLead[] = [];
    const misses: LeadInput[] = [];
    for (const input of inputs) {
      const existing = await db
        .select()
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.orgId, req.orgId!),
            eq(leadsTable.companyDomain, input.companyDomain),
            eq(leadsTable.firstName, input.firstName),
            eq(leadsTable.lastName, input.lastName),
            gte(leadsTable.createdAt, cutoff)
          )
        )
        .limit(1);
      if (existing.length > 0 && existing[0].email) {
        cachedHits.push(rowToNormalized(existing[0]));
      } else {
        misses.push(input);
      }
    }

    let resolved: NormalizedLead[] = [];
    let provisioned: RunCost[] = [];
    if (misses.length > 0) {
      // Worst case: any tier could resolve all misses. clearpath only when opted in.
      const items = [
        { costName: COST_NAME_BY_SOURCE.pipelinelabs, quantity: misses.length },
        { costName: COST_NAME_BY_SOURCE.microworlds, quantity: misses.length },
      ];
      if (includeInferred) {
        items.push({ costName: COST_NAME_BY_SOURCE.clearpath, quantity: misses.length });
      }
      provisioned = await provisionAndAuthorize(
        run.id,
        items,
        `apify-service resolve (${misses.length} leads)`,
        runIdentity
      );
      const result = await resolveEmails(token, misses, Boolean(includeInferred));
      resolved = result.leads;
    }

    const [searchRow] = await db
      .insert(leadSearches)
      .values({
        orgId: req.orgId!,
        runId: run.id,
        brandIds: req.brandIds ?? null,
        campaignId: req.campaignId ?? null,
        featureSlug: req.featureSlug ?? null,
        workflowSlug: req.workflowSlug ?? null,
        mode: "resolve",
        requestParams: { count: inputs.length, includeInferred: Boolean(includeInferred) },
        leadCount: inputs.length,
        verifiedCount: cachedHits.length + resolved.length,
      })
      .returning();

    if (resolved.length > 0) {
      await db
        .insert(leadsTable)
        .values(resolved.map((l) => toLeadRow(req, run.id, searchRow.id, l)))
        .onConflictDoNothing({
          target: [leadsTable.orgId, leadsTable.companyDomain, leadsTable.firstName, leadsTable.lastName],
        });
    }
    // ACTUALIZE real per-actor costs (cache hits are free) + cancel holds.
    if (provisioned.length > 0) {
      await actualizeAndCancel(run.id, resolved, provisioned, runIdentity);
    }

    await updateRun(run.id, "completed", runIdentity);

    const all = [...cachedHits, ...resolved];
    return res.json({
      searchId: searchRow.id,
      requested: inputs.length,
      resolvedCount: all.length,
      leads: all.map(toApiLead),
    });
  } catch (err) {
    await updateRun(run.id, "failed", runIdentity).catch((e) =>
      console.error("[apify-service] failed to mark run failed:", e)
    );
    throw err;
  }
});

// ─── POST /search/count ───────────────────────────────────────────────────────
// Free match-count for a filter set: zero credit spend, zero persistence.
// Backed by the pipelinelabs `countOnly` mode (extracts no leads, no charge),
// so — unlike /search — there is NO run, NO cost declaration, and NO DB write:
// zero billable leads = nothing to declare under the per-lead cost model.

router.post("/search/count", serviceAuth, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = SearchCountRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }

  const token = await getPlatformKey("apify", {
    callerMethod: "POST",
    callerPath: "/search/count",
  });

  const totalMatched = await countMatches(token, parsed.data);
  return res.json({ totalMatched });
});

// ─── GET /search/filters-prompt ───────────────────────────────────────────────
// Stable, versioned description of accepted filters for LLM callers (gap 4).

router.get("/search/filters-prompt", serviceAuth, async (_req: AuthenticatedRequest, res: Response) => {
  return res.json({ prompt: buildFiltersPromptText(), schemaVersion: FILTERS_SCHEMA_VERSION });
});

// ─── GET /search/reference ────────────────────────────────────────────────────
// Accepted-value vocabulary for the enum filters (gap 5).

router.get("/search/reference", serviceAuth, async (_req: AuthenticatedRequest, res: Response) => {
  return res.json({
    industries: filterCatalog.industries,
    seniorities: filterCatalog.seniorities,
    functions: filterCatalog.functions,
    companySizes: filterCatalog.companySizes,
    revenueRanges: filterCatalog.revenueRanges,
    fundingStages: filterCatalog.fundingStages,
  });
});

// ─── GET /searches/:runId ─────────────────────────────────────────────────────

router.get("/searches/:runId", serviceAuth, async (req: AuthenticatedRequest, res: Response) => {
  const rows = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.orgId, req.orgId!), eq(leadsTable.runId, req.params.runId)));
  return res.json({ leads: rows.map((r) => toApiLead(rowToNormalized(r))) });
});

/** Reconstruct a NormalizedLead from a stored DB row. */
function rowToNormalized(r: typeof leadsTable.$inferSelect): NormalizedLead {
  return {
    firstName: r.firstName ?? undefined,
    lastName: r.lastName ?? undefined,
    fullName: r.fullName ?? undefined,
    title: r.title ?? undefined,
    seniority: r.seniority ?? undefined,
    email: r.email ?? "",
    emailStatus: r.emailStatus ?? "unknown",
    source: (r.source as NormalizedLead["source"]) ?? "pipelinelabs",
    isCatchAll: r.isCatchAll,
    isInferred: r.isInferred,
    linkedinUrl: r.linkedinUrl ?? undefined,
    city: r.city ?? undefined,
    state: r.state ?? undefined,
    country: r.country ?? undefined,
    companyName: r.companyName ?? undefined,
    companyDomain: r.companyDomain ?? undefined,
    companyIndustry: r.companyIndustry ?? undefined,
    companySize: r.companySize ?? undefined,
    companyLinkedinUrl: r.companyLinkedinUrl ?? undefined,
    raw: (r.responseRaw as Record<string, unknown>) ?? {},
  };
}

export default router;
