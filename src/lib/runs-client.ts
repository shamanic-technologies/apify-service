import { config } from "../config.js";

export interface IdentityHeaders {
  orgId: string;
  userId?: string;
  runId?: string;
  brandId?: string;
  campaignId?: string;
  featureSlug?: string;
  workflowSlug?: string;
  audienceId?: string;
}

export interface Run {
  id: string;
  organizationId: string;
  serviceName: string;
  taskName: string;
  status: string;
}

export interface CostItem {
  costName: string;
  costSource: "platform" | "org";
  quantity: number;
  status?: "provisioned" | "actual" | "cancelled";
}

async function runsRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; identity?: IdentityHeaders } = {}
): Promise<T> {
  const { method = "GET", body, identity } = options;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": config.runsServiceApiKey,
  };
  if (identity?.orgId) headers["x-org-id"] = identity.orgId;
  if (identity?.userId) headers["x-user-id"] = identity.userId;
  if (identity?.runId) headers["x-run-id"] = identity.runId;
  if (identity?.brandId) headers["x-brand-id"] = identity.brandId;
  if (identity?.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity?.featureSlug) headers["x-feature-slug"] = identity.featureSlug;
  if (identity?.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;
  if (identity?.audienceId) headers["x-audience-id"] = identity.audienceId;

  const response = await fetch(`${config.runsServiceUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `[apify-service] runs-service ${method} ${path} failed: ${response.status} - ${errorText}`
    );
  }
  return response.json() as Promise<T>;
}

export interface CreateRunParams {
  orgId: string;
  userId?: string;
  brandId?: string;
  campaignId?: string;
  featureSlug?: string;
  workflowSlug?: string;
  audienceId?: string;
  parentRunId?: string;
  serviceName: string;
  taskName: string;
}

export async function createRun(params: CreateRunParams): Promise<Run> {
  return runsRequest<Run>("/v1/runs", {
    method: "POST",
    identity: {
      orgId: params.orgId,
      userId: params.userId,
      runId: params.parentRunId,
      audienceId: params.audienceId,
    },
    body: {
      brandId: params.brandId,
      campaignId: params.campaignId,
      featureSlug: params.featureSlug,
      workflowSlug: params.workflowSlug,
      serviceName: params.serviceName,
      taskName: params.taskName,
    },
  });
}

export async function updateRun(
  runId: string,
  status: "completed" | "failed",
  identity: IdentityHeaders
): Promise<Run> {
  return runsRequest<Run>(`/v1/runs/${runId}`, {
    method: "PATCH",
    identity: { ...identity, runId },
    body: { status },
  });
}

export interface RunCost {
  id: string;
  costName: string;
  costSource: "platform" | "org";
  quantity: string;
  status?: string;
}

export async function addCosts(
  runId: string,
  items: CostItem[],
  identity: IdentityHeaders
): Promise<{ costs: RunCost[] }> {
  return runsRequest<{ costs: RunCost[] }>(`/v1/runs/${runId}/costs`, {
    method: "POST",
    identity: { ...identity, runId },
    body: { items },
  });
}

/** Update a cost item's status (provisioned → actual or cancelled). */
export async function updateCostStatus(
  runId: string,
  costId: string,
  status: "actual" | "provisioned" | "cancelled",
  identity: IdentityHeaders
): Promise<RunCost> {
  return runsRequest<RunCost>(`/v1/runs/${runId}/costs/${costId}`, {
    method: "PATCH",
    identity: { ...identity, runId },
    body: { status },
  });
}
