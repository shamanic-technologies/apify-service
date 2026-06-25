import { Request, Response, NextFunction } from "express";

export interface AuthenticatedRequest extends Request {
  orgId?: string;
  userId?: string;
  runId?: string;
  brandId?: string;
  brandIds?: string[];
  campaignId?: string;
  featureSlug?: string;
  workflowSlug?: string;
  audienceId?: string;
}

/** Parse x-brand-id header as CSV — supports single UUID or comma-separated list. */
export function parseBrandIds(raw: string | undefined): string[] {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Middleware for internal service calls (no token — Railway private network).
 * Requires x-org-id and x-user-id. Optionally extracts run-context headers.
 */
export async function serviceAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const orgId = req.headers["x-org-id"] as string | undefined;
  const userId = req.headers["x-user-id"] as string | undefined;

  if (!orgId) {
    return res.status(400).json({ error: "x-org-id header required" });
  }
  if (!userId) {
    return res.status(400).json({ error: "x-user-id header required" });
  }

  req.orgId = orgId;
  req.userId = userId;

  const runId = req.headers["x-run-id"] as string | undefined;
  const brandIdRaw = req.headers["x-brand-id"] as string | undefined;
  const brandIds = parseBrandIds(brandIdRaw);
  const campaignId = req.headers["x-campaign-id"] as string | undefined;
  const featureSlug = req.headers["x-feature-slug"] as string | undefined;
  const workflowSlug = req.headers["x-workflow-slug"] as string | undefined;
  // Audience attribution (campaign-service's priority audience for the run).
  // Optional — absent outside a campaign flow. Same treatment as the other
  // run-context headers; UUID validation happens downstream in runs-service.
  const audienceId = req.headers["x-audience-id"] as string | undefined;

  if (runId) req.runId = runId;
  if (brandIdRaw) req.brandId = brandIdRaw;
  if (brandIds.length > 0) req.brandIds = brandIds;
  if (campaignId) req.campaignId = campaignId;
  if (featureSlug) req.featureSlug = featureSlug;
  if (workflowSlug) req.workflowSlug = workflowSlug;
  if (audienceId) req.audienceId = audienceId;

  next();
}

/**
 * Read-only org auth: requires x-org-id only (no x-user-id). Used by read
 * endpoints whose locked contract carries no user header (e.g. GET an audience
 * by id). Still extracts the optional run-context headers like serviceAuth.
 */
export async function orgReadAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const orgId = req.headers["x-org-id"] as string | undefined;
  if (!orgId) {
    return res.status(400).json({ error: "x-org-id header required" });
  }
  req.orgId = orgId;

  const userId = req.headers["x-user-id"] as string | undefined;
  const runId = req.headers["x-run-id"] as string | undefined;
  const brandIdRaw = req.headers["x-brand-id"] as string | undefined;
  const brandIds = parseBrandIds(brandIdRaw);
  const campaignId = req.headers["x-campaign-id"] as string | undefined;
  const featureSlug = req.headers["x-feature-slug"] as string | undefined;
  const workflowSlug = req.headers["x-workflow-slug"] as string | undefined;
  const audienceId = req.headers["x-audience-id"] as string | undefined;

  if (userId) req.userId = userId;
  if (runId) req.runId = runId;
  if (brandIdRaw) req.brandId = brandIdRaw;
  if (brandIds.length > 0) req.brandIds = brandIds;
  if (campaignId) req.campaignId = campaignId;
  if (featureSlug) req.featureSlug = featureSlug;
  if (workflowSlug) req.workflowSlug = workflowSlug;
  if (audienceId) req.audienceId = audienceId;

  next();
}
