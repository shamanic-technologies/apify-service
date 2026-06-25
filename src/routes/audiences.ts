import { Router, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { apifyAudiences, apifyAudienceRefinements } from "../db/schema.js";
import {
  serviceAuth,
  orgReadAuth,
  AuthenticatedRequest,
} from "../middleware/auth.js";
import { SuggestFromSegmentRequestSchema, type AudienceFilters } from "../schemas.js";
import { getPlatformKey } from "../lib/keys-client.js";
import { IdentityHeaders } from "../lib/runs-client.js";
import { complete } from "../lib/chat-client.js";
import { countMatches } from "../lib/waterfall.js";
import {
  buildFilterJsonSchema,
  FILTERS_SCHEMA_VERSION,
} from "../lib/filter-catalog.js";
import {
  buildAudienceFilters,
  validateFilters,
  type BuilderDeps,
} from "../lib/audience-builder.js";

const router = Router();

function identityFromReq(req: AuthenticatedRequest): IdentityHeaders {
  return {
    orgId: req.orgId!,
    userId: req.userId,
    runId: req.runId,
    brandId: req.brandId,
    campaignId: req.campaignId,
    featureSlug: req.featureSlug,
    workflowSlug: req.workflowSlug,
    audienceId: req.audienceId,
  };
}

function toAudienceResponse(row: typeof apifyAudiences.$inferSelect) {
  return {
    apifyAudienceId: row.id,
    filters: row.filters as AudienceFilters,
    count: row.count,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

// ─── POST /audiences/suggest-from-segment ─────────────────────────────────────
// Build the best FAITHFUL apify filter set from a natural-language segment via
// the agentic refine loop (LLM through chat-service, count via the free
// pipelinelabs countOnly probe), persist it (silver audience + bronze refine
// trail), and return { apifyAudienceId, filters, count }.
//
// Declares NO local cost: the only paid op (the LLM) goes through chat-service,
// which owns + meters that spend against the org; the count probes ride the same
// free countOnly surface as /search/count (no run, no cost declaration).

router.post(
  "/audiences/suggest-from-segment",
  serviceAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const parsed = SuggestFromSegmentRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Invalid request", details: parsed.error.issues });
    }
    const { name, description, brandId } = parsed.data;
    const identity = identityFromReq(req);

    const token = await getPlatformKey("apify", {
      callerMethod: "POST",
      callerPath: "/audiences/suggest-from-segment",
      audienceId: req.audienceId,
    });

    const responseSchema = buildFilterJsonSchema();
    const deps: BuilderDeps = {
      llm: async (systemPrompt, message) => {
        const result = await complete(
          {
            message,
            systemPrompt,
            provider: "google",
            model: "flash",
            temperature: 0.2,
            maxTokens: 2048,
            disableThinking: true,
            responseSchema,
          },
          identity
        );
        // chat-client guarantees `json` is present for a responseSchema request.
        const filters = validateFilters(result.json);
        return {
          filters,
          raw: {
            json: result.json,
            model: result.model,
            tokensInput: result.tokensInput,
            tokensOutput: result.tokensOutput,
          },
        };
      },
      count: (filters) => countMatches(token, filters),
    };

    const built = await buildAudienceFilters(deps, { name, description });

    const [audience] = await db
      .insert(apifyAudiences)
      .values({
        orgId: req.orgId!,
        name,
        description,
        brandId: brandId ?? null,
        filters: built.filters,
        count: built.count,
        status: "ready",
        schemaVersion: FILTERS_SCHEMA_VERSION,
      })
      .returning();

    // Bronze: persist every refine iteration (raw LLM + count probe).
    await db.insert(apifyAudienceRefinements).values(
      built.attempts.map((a) => ({
        audienceId: audience.id,
        orgId: req.orgId!,
        iteration: a.iteration,
        segmentText: `${name}\n${description}`,
        feedback: a.feedback,
        filters: a.filters,
        count: a.count,
        llmRaw: a.llmRaw,
      }))
    );

    return res.json({
      apifyAudienceId: audience.id,
      filters: built.filters,
      count: built.count,
    });
  }
);

// ─── GET /audiences/:apifyAudienceId ──────────────────────────────────────────
// Fetch a persisted apify audience by id (org-scoped). Read auth: x-org-id only.

router.get(
  "/audiences/:apifyAudienceId",
  orgReadAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const [audience] = await db
      .select()
      .from(apifyAudiences)
      .where(
        and(
          eq(apifyAudiences.id, req.params.apifyAudienceId),
          eq(apifyAudiences.orgId, req.orgId!)
        )
      )
      .limit(1);
    if (!audience) {
      return res.status(404).json({ error: "Audience not found" });
    }
    return res.json(toAudienceResponse(audience));
  }
);

// ─── POST /audiences/:apifyAudienceId/dry-run ─────────────────────────────────
// Re-count a persisted audience live (free pipelinelabs countOnly probe) and
// refresh the cached gold count. No paid leads extracted → no cost declaration.

router.post(
  "/audiences/:apifyAudienceId/dry-run",
  serviceAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const [audience] = await db
      .select()
      .from(apifyAudiences)
      .where(
        and(
          eq(apifyAudiences.id, req.params.apifyAudienceId),
          eq(apifyAudiences.orgId, req.orgId!)
        )
      )
      .limit(1);
    if (!audience) {
      return res.status(404).json({ error: "Audience not found" });
    }

    const token = await getPlatformKey("apify", {
      callerMethod: "POST",
      callerPath: "/audiences/:apifyAudienceId/dry-run",
      audienceId: req.audienceId,
    });

    const count = await countMatches(token, audience.filters as AudienceFilters);

    await db
      .update(apifyAudiences)
      .set({ count, updatedAt: new Date() })
      .where(eq(apifyAudiences.id, audience.id));

    return res.json({ count });
  }
);

export default router;
