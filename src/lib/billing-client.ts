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
  };
  if (!data.sufficient) {
    throw new Error(
      `[apify-service] insufficient balance (balance=${data.balance_cents}¢, required=${data.required_cents}¢)`
    );
  }
}
