import {
  addCosts,
  updateCostStatus,
  CostItem,
  RunCost,
  IdentityHeaders,
} from "./runs-client.js";
import { authorize } from "./billing-client.js";
import type { LeadSource, NormalizedLead } from "./waterfall.js";

/**
 * One cost name per actor — each Apify actor has its own price, so cost
 * attribution is per-actor. Org pays per verified lead delivered by each actor.
 * These names MUST be registered in costs-service (else runs-service 422s).
 */
export const COST_NAME_BY_SOURCE: Record<LeadSource, string> = {
  pipelinelabs: "apify-pipelinelabs-lead",
  microworlds: "apify-microworlds-lead",
  clearpath: "apify-clearpath-lead",
};

export interface WorstCaseItem {
  costName: string;
  quantity: number;
}

/**
 * PROVISION worst-case holds, then AUTHORIZE affordability — BEFORE any Apify
 * spend. Provision validates the cost names are declarable (runs-service 422s
 * early, before we hit a paid actor) and reserves the rows. Returns the
 * provisioned cost rows so they can be cancelled at reconciliation.
 */
export async function provisionAndAuthorize(
  runId: string,
  items: WorstCaseItem[],
  description: string,
  identity: IdentityHeaders
): Promise<RunCost[]> {
  const { costs } = await addCosts(
    runId,
    items.map((i) => ({
      costName: i.costName,
      costSource: "platform" as const,
      quantity: i.quantity,
      status: "provisioned" as const,
    })),
    identity
  );
  await authorize(
    items.map((i) => ({ costName: i.costName, quantity: i.quantity })),
    description,
    identity
  );
  return costs;
}

/** Build `actual` cost items grouped by source actor (one line per actor). */
export function actualItemsBySource(leads: NormalizedLead[]): CostItem[] {
  const counts = new Map<LeadSource, number>();
  for (const l of leads) counts.set(l.source, (counts.get(l.source) ?? 0) + 1);
  return [...counts.entries()].map(([source, quantity]) => ({
    costName: COST_NAME_BY_SOURCE[source],
    costSource: "platform" as const,
    quantity,
    status: "actual" as const,
  }));
}

/**
 * ACTUALIZE: declare the real per-actor costs, then CANCEL the provisioned
 * holds (runs PATCH is status-only — no in-place quantity edit, so we post the
 * real quantity as `actual` and cancel the worst-case hold).
 */
export async function actualizeAndCancel(
  runId: string,
  leads: NormalizedLead[],
  provisioned: RunCost[],
  identity: IdentityHeaders
): Promise<void> {
  const actuals = actualItemsBySource(leads);
  if (actuals.length > 0) await addCosts(runId, actuals, identity);
  for (const c of provisioned) {
    await updateCostStatus(runId, c.id, "cancelled", identity);
  }
}
