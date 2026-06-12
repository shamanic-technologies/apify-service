import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the generic Apify runner — keyed by actor id.
const runActorMock = vi.fn();
vi.mock("../../src/lib/apify-client.js", () => ({
  runActor: (...args: unknown[]) => runActorMock(...args),
}));

import {
  searchVerifiedLeads,
  resolveEmails,
  ACTOR_PIPELINELABS,
  ACTOR_MICROWORLDS,
  ACTOR_CLEARPATH,
} from "../../src/lib/waterfall.js";

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
