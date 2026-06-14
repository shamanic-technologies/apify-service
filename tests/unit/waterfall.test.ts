import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the generic Apify runner — keyed by actor id.
const runActorMock = vi.fn();
vi.mock("../../src/lib/apify-client.js", () => ({
  runActor: (...args: unknown[]) => runActorMock(...args),
}));

import {
  searchVerifiedLeads,
  resolveEmails,
  countMatches,
  extractCount,
  plSearchInput,
  plCountInput,
  ENABLED_SOURCES,
  ACTOR_PIPELINELABS,
  ACTOR_MICROWORLDS,
  ACTOR_CLEARPATH,
} from "../../src/lib/waterfall.js";

const isCountInput = (i: unknown) =>
  Boolean((i as Record<string, unknown>)?.countOnly);

const result = (
  items: unknown[],
  chargedEventCounts: Record<string, number> = {}
) => ({ items, chargedEventCounts, usageTotalUsd: 0 });

beforeEach(() => {
  runActorMock.mockReset();
});

describe("ENABLED_SOURCES", () => {
  it("is pipelinelabs-only (microworlds + clearpath disabled)", () => {
    expect([...ENABLED_SOURCES]).toEqual(["pipelinelabs"]);
  });
});

describe("searchVerifiedLeads", () => {
  it("maps pipelinelabs verified leads, dedupes by email, never calls microworlds", async () => {
    runActorMock.mockImplementation((_t: string, actorId: string, input: unknown) => {
      if (actorId === ACTOR_PIPELINELABS && isCountInput(input))
        return Promise.resolve(result([{ count: 10 }]));
      if (actorId === ACTOR_PIPELINELABS) {
        return Promise.resolve(
          result([
            { firstName: "Dennis", lastName: "Criner", fullName: "Dennis Criner", email: "dennis.criner@douglaslabs.com", emailStatus: "deliverable", companyDomain: "douglaslabs.com", companyIndustry: ["Pharma"], companySize: 56 },
            { firstName: "Dup", lastName: "Lead", email: "DENNIS.CRINER@douglaslabs.com" }, // dup email (case-insensitive)
            { firstName: "NoEmail", lastName: "Person" }, // dropped — no email
            { fullName: "🟢 Refer to the log for performance." }, // banner — dropped
          ])
        );
      }
      return Promise.resolve(result([]));
    });

    const { leads } = await searchVerifiedLeads("tok", { titles: ["Marketing Director"], limit: 50 });

    expect(leads).toHaveLength(1);
    const dennis = leads[0];
    expect(dennis.source).toBe("pipelinelabs");
    expect(dennis.emailStatus).toBe("deliverable");
    expect(dennis.companyIndustry).toBe("Pharma");
    // microworlds is disabled — never invoked.
    expect(runActorMock.mock.calls.map((c) => c[1])).not.toContain(ACTOR_MICROWORLDS);
  });

  it("caps returned leads to `limit` (never extracts/returns more than requested)", async () => {
    runActorMock.mockImplementation((_t: string, actorId: string, input: unknown) => {
      if (actorId === ACTOR_PIPELINELABS && isCountInput(input))
        return Promise.resolve(result([{ count: 99 }]));
      if (actorId === ACTOR_PIPELINELABS)
        return Promise.resolve(
          result(
            Array.from({ length: 5 }, (_, i) => ({
              firstName: `F${i}`, lastName: `L${i}`, email: `u${i}@x.com`, companyDomain: "x.com",
            }))
          )
        );
      return Promise.resolve(result([]));
    });
    const { leads } = await searchVerifiedLeads("tok", { titles: ["CMO"], limit: 2 });
    expect(leads).toHaveLength(2);
  });

  it("aggregates charged events from the extraction + count runs (start x2 + lead)", async () => {
    runActorMock.mockImplementation((_t: string, actorId: string, input: unknown) => {
      if (actorId === ACTOR_PIPELINELABS && isCountInput(input))
        return Promise.resolve(result([{ count: 10 }], { "apify-actor-start": 1 }));
      if (actorId === ACTOR_PIPELINELABS)
        return Promise.resolve(
          result(
            [{ firstName: "A", lastName: "B", email: "a@x.com", companyDomain: "x.com" }],
            { "apify-actor-start": 1, "lead-returned": 1 }
          )
        );
      return Promise.resolve(result([]));
    });
    const { chargedEvents } = await searchVerifiedLeads("tok", { titles: ["CMO"], limit: 50 });
    expect(chargedEvents.pipelinelabs).toEqual({ "apify-actor-start": 2, "lead-returned": 1 });
    expect(chargedEvents.microworlds).toBeUndefined();
  });

  it("returns totalMatched from the count probe", async () => {
    runActorMock.mockImplementation((_t: string, actorId: string, input: unknown) => {
      if (actorId === ACTOR_PIPELINELABS && isCountInput(input))
        return Promise.resolve(result([{ count: 5000 }]));
      if (actorId === ACTOR_PIPELINELABS)
        return Promise.resolve(result([{ firstName: "Pl", lastName: "One", email: "pl1@x.com", companyDomain: "x.com" }]));
      return Promise.resolve(result([]));
    });
    const { totalMatched, leads } = await searchVerifiedLeads("tok", { titles: ["CMO"], limit: 50 });
    expect(totalMatched).toBe(5000);
    expect(leads).toHaveLength(1);
  });

  it("offset > 0 paginates pipelinelabs (carries the customOffset cursor)", async () => {
    runActorMock.mockImplementation((_t: string, actorId: string, input: unknown) => {
      if (actorId === ACTOR_PIPELINELABS && isCountInput(input))
        return Promise.resolve(result([{ count: 5000 }]));
      if (actorId === ACTOR_PIPELINELABS)
        return Promise.resolve(result([{ firstName: "Pl", lastName: "One", email: "pl1@x.com", companyDomain: "x.com" }]));
      return Promise.resolve(result([]));
    });
    const { leads } = await searchVerifiedLeads("tok", { titles: ["CMO"], limit: 50, offset: 50 });
    expect(leads).toHaveLength(1);
    expect(runActorMock.mock.calls.map((c) => c[1])).not.toContain(ACTOR_MICROWORLDS);
    const searchCall = runActorMock.mock.calls.find(
      (c) => c[1] === ACTOR_PIPELINELABS && !isCountInput(c[2])
    )!;
    expect((searchCall[2] as Record<string, unknown>).customOffset).toBe(50);
  });
});

describe("plSearchInput / plCountInput", () => {
  it("maps rich filters + offset → customOffset + dontSaveProgress", () => {
    const input = plSearchInput({
      titles: ["CMO"],
      companySizes: ["51-200"],
      revenueRanges: ["1m_10m"],
      fundingStages: ["series_a"],
      technologies: ["HubSpot"],
      limit: 100,
      offset: 200,
    });
    expect(input.companySizeIncludes).toEqual(["51-200"]);
    expect(input.annualRevenueIncludes).toEqual(["1m_10m"]);
    expect(input.fundingStageIncludes).toEqual(["series_a"]);
    expect(input.technologiesIncludes).toEqual(["HubSpot"]);
    expect(input.customOffset).toBe(200);
    expect(input.dontSaveProgress).toBe(true);
    expect(input.totalResults).toBe(100);
  });

  it("omits customOffset / dontSaveProgress when no offset", () => {
    const input = plSearchInput({ titles: ["CMO"], limit: 50 });
    expect(input.customOffset).toBeUndefined();
    expect(input.dontSaveProgress).toBeUndefined();
  });

  it("count input sets countOnly and carries no totalResults", () => {
    const input = plCountInput({ titles: ["CMO"], industries: ["Banking"] });
    expect(input.countOnly).toBe(true);
    expect(input.totalResults).toBeUndefined();
    expect(input.companyIndustryIncludes).toEqual(["Banking"]);
  });

  it("both builders pin the actor's verified-only enum (not 'deliverable')", () => {
    const count = plCountInput({ titles: ["CEO"] });
    const search = plSearchInput({ titles: ["CEO"], limit: 25 });
    expect(count.emailStatusIncludes).toEqual(["verified"]);
    expect(count.hasEmail).toBe(true);
    expect(search.emailStatusIncludes).toEqual(["verified"]);
    expect(search.hasEmail).toBe(true);
  });
});

describe("extractCount", () => {
  it("reads a known count key", () => {
    expect(extractCount([{ count: 4200 }])).toBe(4200);
    expect(extractCount([{ totalResults: "1530" }])).toBe(1530);
  });
  it("falls back to a sole numeric field", () => {
    expect(extractCount([{ matchesAvailable: 77 }])).toBe(77);
  });
  it("fails loud when no count is present", () => {
    expect(() => extractCount([{ note: "no number here" }])).toThrow(/no recognizable count/);
    expect(() => extractCount([])).toThrow(/no recognizable count/);
  });
});

describe("countMatches", () => {
  it("runs pipelinelabs countOnly and returns the parsed count", async () => {
    runActorMock.mockImplementation((_t: string, actorId: string, input: unknown) => {
      if (actorId === ACTOR_PIPELINELABS && isCountInput(input)) {
        return Promise.resolve(result([{ count: 8123 }]));
      }
      throw new Error("unexpected actor call");
    });
    const total = await countMatches("tok", { titles: ["VP Sales"] });
    expect(total).toBe(8123);
    const calls = runActorMock.mock.calls;
    expect(calls).toHaveLength(1);
    expect(isCountInput(calls[0][2])).toBe(true);
  });
});

describe("resolveEmails", () => {
  it("tier-1: resolves via pipelinelabs name+domain, matched on last name", async () => {
    runActorMock.mockImplementation((_t: string, actorId: string) => {
      if (actorId === ACTOR_PIPELINELABS) {
        return Promise.resolve(
          result([
            { firstName: "Dennis", lastName: "Criner", email: "dennis.criner@douglaslabs.com", emailStatus: "deliverable", companyDomain: "douglaslabs.com" },
          ])
        );
      }
      return Promise.resolve(result([]));
    });

    const { leads, chargedEvents } = await resolveEmails(
      "tok",
      [{ firstName: "Dennis", lastName: "Criner", companyDomain: "douglaslabs.com" }],
      false
    );
    expect(leads).toHaveLength(1);
    expect(leads[0].source).toBe("pipelinelabs");
    expect(leads[0].email).toBe("dennis.criner@douglaslabs.com");
    expect(chargedEvents.pipelinelabs).toBeDefined();
  });

  it("aggregates pipelinelabs charged events across the per-lead runs", async () => {
    runActorMock.mockResolvedValue(result([], { "apify-actor-start": 1 }));
    const { chargedEvents } = await resolveEmails(
      "tok",
      [
        { firstName: "A", lastName: "B", companyDomain: "x.com" },
        { firstName: "C", lastName: "D", companyDomain: "y.com" },
      ],
      false
    );
    expect(chargedEvents.pipelinelabs).toEqual({ "apify-actor-start": 2 });
  });

  it("clearpath disabled: includeInferred=true does NOT call clearpath, returns no inferred", async () => {
    runActorMock.mockResolvedValue(result([])); // pipelinelabs miss

    const { leads } = await resolveEmails(
      "tok",
      [{ firstName: "Safe", lastName: "One", companyDomain: "a.com" }],
      true
    );
    expect(leads).toHaveLength(0);
    const calledActors = runActorMock.mock.calls.map((c) => c[1]);
    expect(calledActors).not.toContain(ACTOR_CLEARPATH);
    expect(calledActors).not.toContain(ACTOR_MICROWORLDS);
    expect(calledActors).toContain(ACTOR_PIPELINELABS);
  });

  it("does not call the disabled microworlds / clearpath tiers on a full miss", async () => {
    runActorMock.mockResolvedValue(result([])); // everything misses

    const { leads } = await resolveEmails(
      "tok",
      [{ firstName: "Ghost", lastName: "User", companyDomain: "x.com" }],
      false
    );
    expect(leads).toHaveLength(0);
    const calledActors = runActorMock.mock.calls.map((c) => c[1]);
    expect(calledActors).not.toContain(ACTOR_CLEARPATH);
    expect(calledActors).not.toContain(ACTOR_MICROWORLDS);
    expect(calledActors).toContain(ACTOR_PIPELINELABS);
  });
});
