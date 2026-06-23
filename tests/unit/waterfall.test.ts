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
  mapVerifyStatus,
  verifyEmails,
  ENABLED_SOURCES,
  ACTOR_PIPELINELABS,
  ACTOR_MICROWORLDS,
  ACTOR_CLEARPATH,
  ACTOR_EMAIL_VERIFIER,
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

  it("counts 2 pipelinelabs runs (extraction + count probe) for actor-start billing", async () => {
    runActorMock.mockImplementation((_t: string, actorId: string, input: unknown) => {
      if (actorId === ACTOR_PIPELINELABS && isCountInput(input))
        return Promise.resolve(result([{ count: 10 }]));
      if (actorId === ACTOR_PIPELINELABS)
        return Promise.resolve(result([{ firstName: "A", lastName: "B", email: "a@x.com", companyDomain: "x.com" }]));
      return Promise.resolve(result([]));
    });
    const { runsBySource } = await searchVerifiedLeads("tok", { titles: ["CMO"], limit: 50 });
    expect(runsBySource.pipelinelabs).toBe(2);
    expect(runsBySource.microworlds).toBeUndefined();
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

    const { leads, runsBySource } = await resolveEmails(
      "tok",
      [{ firstName: "Dennis", lastName: "Criner", companyDomain: "douglaslabs.com" }],
      false
    );
    expect(leads).toHaveLength(1);
    expect(leads[0].source).toBe("pipelinelabs");
    expect(leads[0].email).toBe("dennis.criner@douglaslabs.com");
    expect(runsBySource.pipelinelabs).toBe(1);
  });

  it("counts one pipelinelabs run per input lead (tier 1) for actor-start billing", async () => {
    runActorMock.mockResolvedValue(result([]));
    const { runsBySource } = await resolveEmails(
      "tok",
      [
        { firstName: "A", lastName: "B", companyDomain: "x.com" },
        { firstName: "C", lastName: "D", companyDomain: "y.com" },
      ],
      false
    );
    expect(runsBySource.pipelinelabs).toBe(2);
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

describe("mapVerifyStatus (bounceverify verdict → 5-literal enum)", () => {
  it("maps a SMTP-confirmed mailbox to valid", () => {
    expect(
      mapVerifyStatus({ status: "valid", smtp_valid: true, is_catch_all: false })
    ).toBe("valid");
  });

  it("maps no-MX / mailbox-does-not-exist to invalid", () => {
    expect(mapVerifyStatus({ status: "invalid", mx_found: false })).toBe("invalid");
    expect(mapVerifyStatus({ status: "invalid", smtp_valid: false })).toBe("invalid");
  });

  it("maps a catch-all domain to catch_all", () => {
    expect(
      mapVerifyStatus({ status: "risky", smtp_valid: true, is_catch_all: true })
    ).toBe("catch_all");
  });

  it("prefers invalid over catch_all (no live mailbox trumps catch-all flag)", () => {
    expect(mapVerifyStatus({ status: "invalid", is_catch_all: true })).toBe("invalid");
  });

  it("prefers catch_all over a valid status when the catch-all flag is set", () => {
    expect(mapVerifyStatus({ status: "valid", is_catch_all: true })).toBe("catch_all");
  });

  it("folds a spam-trap onto risky", () => {
    expect(mapVerifyStatus({ status: "valid", is_spamtrap: true })).toBe("risky");
  });

  it("maps risky to risky", () => {
    expect(mapVerifyStatus({ status: "risky", is_catch_all: false })).toBe("risky");
  });

  it("maps unknown to unknown", () => {
    expect(mapVerifyStatus({ status: "unknown" })).toBe("unknown");
  });

  it("maps an unrecognized / missing status to unknown", () => {
    expect(mapVerifyStatus({ status: "weird-new-value" })).toBe("unknown");
    expect(mapVerifyStatus({})).toBe("unknown");
  });

  it("treats is_catch_all only when strictly true (false = confirmed not catch-all)", () => {
    expect(mapVerifyStatus({ status: "valid", is_catch_all: false })).toBe("valid");
  });
});

describe("verifyEmails", () => {
  it("returns one verdict per input email, matched case-insensitively", async () => {
    runActorMock.mockResolvedValue(
      result([
        { email: "good@acme.com", status: "valid", smtp_valid: true, is_catch_all: false },
        { email: "bounce@nope.com", status: "invalid", smtp_valid: false },
        { email: "any@catchall.com", status: "risky", is_catch_all: true },
      ])
    );

    const { verdicts, billableCount } = await verifyEmails("tok", [
      "GOOD@acme.com",
      "bounce@nope.com",
      "any@catchall.com",
    ]);

    expect(runActorMock).toHaveBeenCalledWith(
      "tok",
      ACTOR_EMAIL_VERIFIER,
      expect.objectContaining({ emails: ["GOOD@acme.com", "bounce@nope.com", "any@catchall.com"] })
    );
    expect(verdicts).toEqual([
      { email: "GOOD@acme.com", status: "valid" },
      { email: "bounce@nope.com", status: "invalid" },
      { email: "any@catchall.com", status: "catch_all" },
    ]);
    expect(billableCount).toBe(3);
  });

  it("resolves an input the actor returned no row for to unknown", async () => {
    runActorMock.mockResolvedValue(
      result([{ email: "seen@acme.com", status: "valid", is_catch_all: false }])
    );

    const { verdicts, billableCount } = await verifyEmails("tok", [
      "seen@acme.com",
      "missing@acme.com",
    ]);

    expect(verdicts).toEqual([
      { email: "seen@acme.com", status: "valid" },
      { email: "missing@acme.com", status: "unknown" },
    ]);
    expect(billableCount).toBe(1);
  });

  it("does not bill `unknown` rows (bounceverify charges only decisive results)", async () => {
    runActorMock.mockResolvedValue(
      result([
        { email: "good@acme.com", status: "valid", smtp_valid: true },
        { email: "blocked@smtp-wall.com", status: "unknown" },
      ])
    );

    const { verdicts, billableCount } = await verifyEmails("tok", [
      "good@acme.com",
      "blocked@smtp-wall.com",
    ]);

    expect(verdicts).toEqual([
      { email: "good@acme.com", status: "valid" },
      { email: "blocked@smtp-wall.com", status: "unknown" },
    ]);
    // 2 rows returned, but only the decisive one is billable.
    expect(billableCount).toBe(1);
  });
});
