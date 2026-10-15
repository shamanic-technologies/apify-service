import type express from "express";
import { BillingRefusedError } from "./billing-client.js";

/**
 * Final Express error handler. Every unhandled error is a 500
 * `{ error: "Internal server error" }`, unchanged — EXCEPT a billing refusal
 * for a sales funnel (campaign) MAX BUDGET: same 500, but the body names the
 * cause and carries billing's `reason` + `sales_funnel_cap` verbatim, so the
 * caller can tell "raise this campaign's max budget" apart from "add credit".
 */
export function errorHandler(
  err: Error,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction
): void {
  console.error("[apify-service] Unhandled error:", err);
  if (err instanceof BillingRefusedError && err.reason) {
    res.status(500).json({
      error: "Sales funnel max budget reached",
      reason: err.reason,
      ...(err.salesFunnelCap !== undefined ? { sales_funnel_cap: err.salesFunnelCap } : {}),
    });
    return;
  }
  res.status(500).json({ error: "Internal server error" });
}
