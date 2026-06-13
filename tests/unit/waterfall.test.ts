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
  ACTOR_PIPELINELABS,
  ACTOR_MICROWORLDS,
  ACTOR_CLEARPATH,
} from "../../src/lib/waterfall.js";

const isCountInput = (i: unknown) =>
  Boolean((i as Record<string, unknown>)?.countOnly);

const result = (items: unknown[]) => ({ items, chargedEventCounts: {}, usageTotalUsd: 0 });

beforeEach(() => {
  runActorMock.mockReset();
});

describe("searchVerifiedLeads", () => {
  it("maps pipelinelabs + microworlds verified leads and dedupes by email", async () => {
    runActorMock.mockImplementation((_t: string, actorId: string) => {
      if (actorId === ACTOR_PIPELINELABS) {
        return Promise.resolve(
          result([
            { firstName: "Dennis", lastName: "Criner", fullName: "Dennis Criner", email: "dennis.criner@douglaslabs.com", emailStatus: "deliverable", companyDomain: "douglaslabs.com", companyIndustry: ["Pharma"], companySize: 56 },
            { firstName: "NoEmail", lastName: "Person" }, // dropped — no email
            { fullName: "🟢 Refer to the log for performance." }, // banner — dropped
          ])
        );
      }
      if (actorId === ACTOR_MICROWORLDS) {
        return Promise.resolve(
          result([
            { first_name: "Jane", last_name: "Doe", email: "jane@acme.com", organization_primary_domain: "acme.com", domain_is_catchall: true },
            { first_name: "Dup", last_name: "Lead", email: "DENNIS.CRINER@douglaslabs.com" }, // dup email (case-insensitive)
          ])
        );
      }
      return Promise.resolve(result([]));
    });

    const { leads } = await searchVerifiedLeads("tok", { titles: ["Marketing Director"], limit: 50 });

    // dennis (PL) + jane (MW); the MW duplicate email is removed.
    expect(leads).toHaveLength(2);
    const dennis = leads.find((l) => l.email === "dennis.criner@douglaslabs.com")!;
    expect(dennis.source).toBe("pipelinelabs");
    expect(dennis.emailStatus).toBe("deliverable");
    expect(dennis.companyIndustry).toBe("Pharma");
    const jane = leads.find((l) => l.email === "jane@acme.com")!;
    expect(jane.source).toBe("microworlds");
    expect(jane.emailStatus).toBe("verified");
    expect(jane.isCatchAll).toBe(true);
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
    // Actor rejects any emailStatusIncludes outside "verified" / "unverified"
    // with a 400 invalid-input — guards against the #9 regression.
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
    // only the count actor was hit — no lead extraction, no microworlds.
    const calls = runActorMock.mock.calls;
    expect(calls).toHaveLength(1);
    expect(isCountInput(calls[0][2])).toBe(true);
  });
});

describe("searchVerifiedLeads paging", () => {
  const search = (a: string, input: unknown) => {
    if (a === ACTOR_PIPELINELABS && isCountInput(input)) return result([{ count: 5000 }]);
    if (a === ACTOR_PIPELINELABS)
      return result([{ firstName: "Pl", lastName: "One", email: "pl1@x.com", companyDomain: "x.com" }]);
    if (a === ACTOR_MICROWORLDS)
      return result([{ first_name: "Mw", last_name: "Two", email: "mw2@y.com", organization_primary_domain: "y.com" }]);
    return result([]);
  };

  it("returns totalMatched from the count probe (page 1 includes microworlds)", async () => {
    runActorMock.mockImplementation((_t: string, a: string, i: unknown) => Promise.resolve(search(a, i)));
    const { leads, totalMatched } = await searchVerifiedLeads("tok", { titles: ["CMO"], limit: 50 });
    expect(totalMatched).toBe(5000);
    expect(leads).toHaveLength(2); // pl + mw merged
    expect(new Set(runActorMock.mock.calls.map((c) => c[1]))).toContain(ACTOR_MICROWORLDS);
  });

  it("offset > 0 skips microworlds (no offset support) and paginates pipelinelabs", async () => {
    runActorMock.mockImplementation((_t: string, a: string, i: unknown) => Promise.resolve(search(a, i)));
    const { leads, totalMatched } = await searchVerifiedLeads("tok", { titles: ["CMO"], limit: 50, offset: 50 });
    expect(totalMatched).toBe(5000);
    expect(leads).toHaveLength(1); // pipelinelabs only
    const actors = runActorMock.mock.calls.map((c) => c[1]);
    expect(actors).not.toContain(ACTOR_MICROWORLDS);
    // the search call carried the offset cursor.
    const searchCall = runActorMock.mock.calls.find(
      (c) => c[1] === ACTOR_PIPELINELABS && !isCountInput(c[2])
    )!;
    expect((searchCall[2] as Record<string, unknown>).customOffset).toBe(50);
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

    const { leads } = await resolveEmails(
      "tok",
      [{ firstName: "Dennis", lastName: "Criner", companyDomain: "douglaslabs.com" }],
      false
    );
    expect(leads).toHaveLength(1);
    expect(leads[0].source).toBe("pipelinelabs");
    expect(leads[0].email).toBe("dennis.criner@douglaslabs.com");
  });

  it("tier-3: clearpath only returns safe-to-send, non-catch-all, tagged inferred", async () => {
    runActorMock.mockImplementation((_t: string, actorId: string) => {
      if (actorId === ACTOR_CLEARPATH) {
        return Promise.resolve(
          result([
            { firstName: "Safe", surname: "One", domain: "a.com", email: "safe@a.com", isSafeToSend: true, isCatchAll: false },
            { firstName: "Catch", surname: "All", domain: "b.com", email: "catch@b.com", isSafeToSend: false, isCatchAll: true },
          ])
        );
      }
      return Promise.resolve(result([])); // PL + MW miss
    });

    const { leads } = await resolveEmails(
      "tok",
      [
        { firstName: "Safe", lastName: "One", companyDomain: "a.com" },
        { firstName: "Catch", lastName: "All", companyDomain: "b.com" },
      ],
      true
    );
    expect(leads).toHaveLength(1);
    expect(leads[0].source).toBe("clearpath");
    expect(leads[0].isInferred).toBe(true);
    expect(leads[0].emailStatus).toBe("inferred");
  });

  it("does not call clearpath when includeInferred is false", async () => {
    runActorMock.mockResolvedValue(result([])); // everything misses

    const { leads } = await resolveEmails(
      "tok",
      [{ firstName: "Ghost", lastName: "User", companyDomain: "x.com" }],
      false
    );
    expect(leads).toHaveLength(0);
    const calledActors = runActorMock.mock.calls.map((c) => c[1]);
    expect(calledActors).not.toContain(ACTOR_CLEARPATH);
    expect(calledActors).toContain(ACTOR_PIPELINELABS);
    expect(calledActors).toContain(ACTOR_MICROWORLDS);
  });
});
