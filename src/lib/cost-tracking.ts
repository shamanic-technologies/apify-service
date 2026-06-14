import {
  addCosts,
  updateCostStatus,
  CostItem,
  RunCost,
  IdentityHeaders,
} from "./runs-client.js";
import { authorize } from "./billing-client.js";
import type { LeadSource, ChargedEventsBySource } from "./waterfall.js";

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
 * 100%-passthrough table: map each actor's Apify charged-event name → the
 * costs-service cost name. Every event Apify bills us is declared here. An event
 * NOT in this table fails loud (eventCostItems throws) rather than going
 * unbilled — that's the whole point of refacturing every cost.
 *
 * Only the pipelinelabs entries have registered cost names in costs-service
 * today; the microworlds/clearpath rows document the future mapping and will
 * 422 (fail loud) if their source is re-enabled before the names are created.
 */
const COST_NAME_BY_EVENT: Record<LeadSource, Record<string, string>> = {
  pipelinelabs: {
    "apify-actor-start": "apify-pipelinelabs-actor-start",
    "lead-returned": "apify-pipelinelabs-lead",
  },
  microworlds: {
    "apify-actor-start": "apify-microworlds-actor-start",
    leads: "apify-microworlds-lead",
  },
  clearpath: {
    actor_start: "apify-clearpath-actor-start",
    email_pattern_tested: "apify-clearpath-pattern-tested",
  },
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

/**
 * Build `actual` cost items from the real Apify charged events — one line per
 * (source, event). This is the 100%-passthrough actualization: start fees AND
 * per-lead fees, exactly as Apify billed us. Fails loud on an unmapped event.
 */
export function eventCostItems(chargedEvents: ChargedEventsBySource): CostItem[] {
  const items: CostItem[] = [];
  for (const [source, events] of Object.entries(chargedEvents) as [
    LeadSource,
    Record<string, number> | undefined,
  ][]) {
    const map = COST_NAME_BY_EVENT[source];
    for (const [event, quantity] of Object.entries(events ?? {})) {
      if (!quantity || quantity <= 0) continue;
      const costName = map?.[event];
      if (!costName) {
        throw new Error(
          `[apify-service] unmapped Apify charged event "${source}/${event}" — cannot declare its cost (would under-bill the org)`
        );
      }
      items.push({
        costName,
        costSource: "platform" as const,
        quantity,
        status: "actual" as const,
      });
    }
  }
  return items;
}

/**
 * ACTUALIZE: declare the real per-event costs (start + per-lead), then CANCEL
 * the provisioned worst-case holds (runs PATCH is status-only — no in-place
 * quantity edit, so we post the real quantity as `actual` and cancel the hold).
 */
export async function actualizeAndCancel(
  runId: string,
  chargedEvents: ChargedEventsBySource,
  provisioned: RunCost[],
  identity: IdentityHeaders
): Promise<void> {
  const actuals = eventCostItems(chargedEvents);
  if (actuals.length > 0) await addCosts(runId, actuals, identity);
  for (const c of provisioned) {
    await updateCostStatus(runId, c.id, "cancelled", identity);
  }
}
