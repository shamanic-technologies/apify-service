import {
  addCosts,
  updateCostStatus,
  CostItem,
  RunCost,
  IdentityHeaders,
} from "./runs-client.js";
import { authorize } from "./billing-client.js";
import type { LeadSource, NormalizedLead, RunsBySource } from "./waterfall.js";

/**
 * Per-actor LEAD cost name (used for the worst-case provision hold). Org pays
 * per verified lead delivered by each actor. MUST exist in costs-service.
 */
export const COST_NAME_BY_SOURCE: Record<LeadSource, string> = {
  pipelinelabs: "apify-pipelinelabs-lead",
  microworlds: "apify-microworlds-lead",
  clearpath: "apify-clearpath-lead",
};

/**
 * Per-actor RUN (actor-start) cost name. Apify charges a start fee per run; we
 * pass it through 100%. Only `apify-pipelinelabs-actor-start` is registered in
 * costs-service today — the others must be created there before re-enabling
 * those sources (see ENABLED_SOURCES in waterfall.ts).
 */
export const START_COST_BY_SOURCE: Record<LeadSource, string> = {
  pipelinelabs: "apify-pipelinelabs-actor-start",
  microworlds: "apify-microworlds-actor-start",
  clearpath: "apify-clearpath-actor-start",
};

/**
 * Email-VERIFICATION cost name (POST /verify, backed by the bounceverify actor).
 * ONE billable event per the Apify PAY_PER_EVENT model: a per-EMAIL verified fee
 * ($0.00089), no actor-start. MUST exist in costs-service (seeded there) or
 * runs-service 422s the provision before any spend.
 */
export const VERIFY_EMAIL_COST = "apify-bounceverify-email";


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

/**
 * Build `actual` per-LEAD cost items, one line per source actor — billed from
 * the DELIVERED lead count (what the org receives). Reliable: derived from the
 * leads we actually return, not from Apify's unreliable `chargedEventCounts`.
 */
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
 * Build `actual` per-RUN (actor-start) cost items, one line per source actor —
 * billed from the count of runs we executed (Apify charges one start per run).
 */
export function startItemsBySource(runsBySource: RunsBySource): CostItem[] {
  return Object.entries(runsBySource)
    .filter(([, n]) => typeof n === "number" && n > 0)
    .map(([source, n]) => ({
      costName: START_COST_BY_SOURCE[source as LeadSource],
      costSource: "platform" as const,
      quantity: n as number,
      status: "actual" as const,
    }));
}

/**
 * ACTUALIZE: declare the real costs — per delivered lead AND per run executed —
 * then CANCEL the provisioned worst-case holds (runs PATCH is status-only, so we
 * post the real quantity as `actual` and cancel the hold).
 */
export async function actualizeAndCancel(
  runId: string,
  leads: NormalizedLead[],
  runsBySource: RunsBySource,
  provisioned: RunCost[],
  identity: IdentityHeaders
): Promise<void> {
  const actuals = [...actualItemsBySource(leads), ...startItemsBySource(runsBySource)];
  await actualizeItemsAndCancel(runId, actuals, provisioned, identity);
}

/**
 * Generic ACTUALIZE + CANCEL: post arbitrary `actual` cost items, then cancel the
 * provisioned worst-case holds. Used by /verify (its billable units are emails +
 * one actor-start, not lead sources).
 */
export async function actualizeItemsAndCancel(
  runId: string,
  actuals: CostItem[],
  provisioned: RunCost[],
  identity: IdentityHeaders
): Promise<void> {
  if (actuals.length > 0) await addCosts(runId, actuals, identity);
  for (const c of provisioned) {
    await updateCostStatus(runId, c.id, "cancelled", identity);
  }
}
