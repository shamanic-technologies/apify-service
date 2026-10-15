import { config } from "../config.js";
import type { IdentityHeaders } from "./runs-client.js";

const TIMEOUT_MS = 30_000;

export interface AuthorizeItem {
  costName: string;
  quantity: number;
}

/**
 * Pre-execution affordability check for platform-key spend (the Apify actors
 * are paid with our platform Apify key, so the org's balance must cover it).
 * Fail-loud: a non-2xx response OR sufficient:false throws, blocking spend.
 */
export async function authorize(
  items: AuthorizeItem[],
  description: string,
  identity: IdentityHeaders
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": config.billingServiceApiKey,
    "x-org-id": identity.orgId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.brandId) headers["x-brand-id"] = identity.brandId;
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.audienceId) headers["x-audience-id"] = identity.audienceId;

  let res: Response;
  try {
    res = await fetch(`${config.billingServiceUrl}/v1/customer_balance/authorize`, {
      method: "POST",
      headers,
      body: JSON.stringify({ items, description }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `[apify-service] billing-service authorize fetch failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `[apify-service] billing-service authorize failed (${res.status}): ${text}`
    );
  }
  const data = (await res.json()) as {
    sufficient: boolean;
    balance_cents?: string;
    required_cents?: string;
    reason?: string;
    sales_funnel_cap?: Record<string, unknown>;
  };
  if (!data.sufficient) {
    if (data.reason) {
      // A sales funnel (campaign) MAX BUDGET refusal, not a balance shortfall:
      // the org may have credit. Name the real cause and carry billing's
      // `reason` + `sales_funnel_cap` verbatim to the caller.
      throw new BillingRefusedError(
        `[apify-service] sales funnel max budget reached (reason=${data.reason}, balance=${data.balance_cents}¢, required=${data.required_cents}¢)`,
        data.reason,
        data.sales_funnel_cap
      );
    }
    throw new BillingRefusedError(
      `[apify-service] insufficient balance (balance=${data.balance_cents}¢, required=${data.required_cents}¢)`
    );
  }
}

/**
 * billing-service answered `sufficient:false`. `reason` (+ `salesFunnelCap`)
 * is set ONLY when billing refused for a sales funnel's max budget; a plain
 * balance shortfall carries neither and keeps its old message.
 */
export class BillingRefusedError extends Error {
  constructor(
    message: string,
    readonly reason?: string,
    readonly salesFunnelCap?: Record<string, unknown>
  ) {
    super(message);
    this.name = "BillingRefusedError";
  }
}
