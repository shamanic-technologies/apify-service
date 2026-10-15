/**
 * FUNNEL-CAP-NAMED-402-1016: a billing refusal for a sales funnel (campaign)
 * MAX BUDGET must reach the caller named, with billing's `reason` +
 * `sales_funnel_cap` verbatim. A plain balance shortfall stays byte-identical.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import "express-async-errors";
import request from "supertest";

beforeAll(() => {
  process.env.BILLING_SERVICE_URL = "http://billing.test";
  process.env.BILLING_SERVICE_API_KEY = "billing-key";
});

const verifyEmails = vi.fn();
vi.mock("../../src/lib/keys-client.js", () => ({
  getPlatformKey: vi.fn(async () => "apify-token"),
}));
vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn(async () => ({ id: "run-1" })),
  updateRun: vi.fn(async () => ({})),
  addCosts: vi.fn(async () => ({ costs: [{ id: "cost-1" }] })),
  updateCostStatus: vi.fn(async () => ({})),
}));
vi.mock("../../src/lib/waterfall.js", () => ({
  verifyEmails: (...args: unknown[]) => verifyEmails(...args),
}));

import verifyRoutes from "../../src/routes/verify.js";
import { errorHandler } from "../../src/lib/error-handler.js";

const CAP = {
  salesFunnelId: "sf-1",
  salesFunnelCampaignId: "sfc-1",
  amountCents: 5000,
  period: "month",
  consumedCents: 4990,
  reservedCents: 0,
};

function billingAnswers(body: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }))
  );
}

function app() {
  const a = express();
  a.use(express.json());
  a.use(verifyRoutes);
  a.use(errorHandler);
  return a;
}

const post = () =>
  request(app())
    .post("/verify")
    .set("x-org-id", "06ffd332-0000-0000-0000-000000000000")
    .set("x-user-id", "u-1")
    .send({ emails: ["a@example.com"] });

beforeEach(() => {
  verifyEmails.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("billing refusal reaches the caller with its real cause", () => {
  it("sales funnel max budget: names it, carries reason + sales_funnel_cap verbatim", async () => {
    billingAnswers({
      sufficient: false,
      balance_cents: "100000",
      required_cents: "1",
      reason: "sales_funnel_max_budget_reached",
      sales_funnel_cap: CAP,
    });
    const res = await post();
    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual({
      error: "Sales funnel max budget reached",
      reason: "sales_funnel_max_budget_reached",
      sales_funnel_cap: CAP,
    });
    expect(verifyEmails).not.toHaveBeenCalled();
  });

  it("unreadable cap reason is relayed too", async () => {
    billingAnswers({
      sufficient: false,
      balance_cents: "100000",
      required_cents: "1",
      reason: "sales_funnel_max_budget_unreadable",
      sales_funnel_cap: CAP,
    });
    const res = await post();
    expect(res.body.reason).toBe("sales_funnel_max_budget_unreadable");
    expect(res.body.sales_funnel_cap).toStrictEqual(CAP);
  });

  it("balance shortfall (no reason): body byte-identical to before", async () => {
    billingAnswers({ sufficient: false, balance_cents: "0", required_cents: "1" });
    const res = await post();
    expect(res.status).toBe(500);
    expect(res.text).toBe(JSON.stringify({ error: "Internal server error" }));
    expect(verifyEmails).not.toHaveBeenCalled();
  });
});
