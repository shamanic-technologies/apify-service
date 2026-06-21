/**
 * Regression: x-audience-id attribution plumbing (per-audience cost attribution).
 *
 * Locks the invariant: an inbound x-audience-id is
 *   1. read into the request identity (auth middleware),
 *   2. forwarded on EVERY internal-service call (runs / billing / key-service),
 *   3. NEVER forwarded to the external Apify vendor (egress strip).
 *
 * Without this, apify-service's lead-cost rows land in the "unattributed"
 * bucket and the per-audience CPC is wrong.
 */
import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from "vitest";

// Internal-service URLs must be set before the lazy config getters read them.
beforeAll(() => {
  process.env.RUNS_SERVICE_URL = "http://runs.test";
  process.env.RUNS_SERVICE_API_KEY = "runs-key";
  process.env.BILLING_SERVICE_URL = "http://billing.test";
  process.env.BILLING_SERVICE_API_KEY = "billing-key";
  process.env.KEY_SERVICE_URL = "http://keys.test";
  process.env.KEY_SERVICE_API_KEY = "keys-key";
});

import { serviceAuth, AuthenticatedRequest } from "../../src/middleware/auth.js";
import { createRun, addCosts } from "../../src/lib/runs-client.js";
import { authorize } from "../../src/lib/billing-client.js";
import { getPlatformKey } from "../../src/lib/keys-client.js";
import { runActor } from "../../src/lib/apify-client.js";

const AUD = "11111111-1111-1111-1111-111111111111";

/** Capture the headers of every fetch call; return a JSON body by default. */
function mockFetch(body: unknown = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => "",
    } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("auth middleware reads x-audience-id (inbound)", () => {
  it("sets req.audienceId from the header", () => {
    const req = {
      headers: { "x-org-id": "o1", "x-user-id": "u1", "x-audience-id": AUD },
    } as unknown as AuthenticatedRequest;
    const res = {} as never;
    const next = vi.fn();
    serviceAuth(req, res, next);
    expect(req.audienceId).toBe(AUD);
    expect(next).toHaveBeenCalledOnce();
  });

  it("leaves req.audienceId unset when the header is absent (no throw)", () => {
    const req = {
      headers: { "x-org-id": "o1", "x-user-id": "u1" },
    } as unknown as AuthenticatedRequest;
    const next = vi.fn();
    serviceAuth(req, {} as never, next);
    expect(req.audienceId).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("internal egress forwards x-audience-id", () => {
  let calls: Array<{ url: string; headers: Record<string, string> }>;
  beforeEach(() => {
    calls = mockFetch({ id: "r1", sufficient: true, key: "platform-token" });
  });

  it("createRun → runs-service carries x-audience-id", async () => {
    await createRun({
      orgId: "o1",
      audienceId: AUD,
      serviceName: "apify-service",
      taskName: "search",
    });
    expect(calls[0].headers["x-audience-id"]).toBe(AUD);
  });

  it("addCosts → runs-service carries x-audience-id (tags the cost row)", async () => {
    await addCosts(
      "r1",
      [{ costName: "apify-pipelinelabs-lead", costSource: "platform", quantity: 1 }],
      { orgId: "o1", audienceId: AUD }
    );
    expect(calls[0].headers["x-audience-id"]).toBe(AUD);
  });

  it("billing authorize carries x-audience-id", async () => {
    await authorize([{ costName: "apify-pipelinelabs-lead", quantity: 1 }], "test", {
      orgId: "o1",
      audienceId: AUD,
    });
    expect(calls[0].headers["x-audience-id"]).toBe(AUD);
  });

  it("getPlatformKey (key-service) carries x-audience-id", async () => {
    await getPlatformKey("apify", {
      callerMethod: "POST",
      callerPath: "/search",
      audienceId: AUD,
    });
    expect(calls[0].headers["x-audience-id"]).toBe(AUD);
  });

  it("omits the header entirely when no audienceId is present", async () => {
    await addCosts(
      "r1",
      [{ costName: "apify-pipelinelabs-lead", costSource: "platform", quantity: 1 }],
      { orgId: "o1" }
    );
    expect("x-audience-id" in calls[0].headers).toBe(false);
  });
});

describe("external egress strips internal tracking headers", () => {
  it("never sends x-audience-id to the Apify vendor API", async () => {
    const calls = mockFetch({
      data: { id: "run1", status: "SUCCEEDED", defaultDatasetId: "ds1" },
    });
    await runActor("platform-token", "pipelinelabs~lead-scraper", { limit: 1 });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.url).toContain("api.apify.com");
      expect("x-audience-id" in c.headers).toBe(false);
      expect(c.headers["Authorization"]).toBe("Bearer platform-token");
    }
  });
});
