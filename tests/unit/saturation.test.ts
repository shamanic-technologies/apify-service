import { describe, it, expect } from "vitest";
import {
  emissionKey,
  normalizeEmail,
  normalizeLinkedinUrl,
  isGatewayExcluded,
  selectFreshLeads,
  computePaging,
} from "../../src/lib/saturation.js";

describe("emissionKey", () => {
  it("is case-insensitive and trims whitespace", () => {
    const a = emissionKey({
      companyDomain: "Acme.com",
      firstName: "John",
      lastName: "Doe",
    });
    const b = emissionKey({
      companyDomain: " acme.com ",
      firstName: " john",
      lastName: "DOE ",
    });
    expect(a).toBe(b);
  });

  it("maps null / undefined fields to empty segments", () => {
    expect(emissionKey({})).toBe("||");
    expect(
      emissionKey({ companyDomain: null, firstName: null, lastName: null })
    ).toBe("||");
    expect(emissionKey({ companyDomain: "acme.com" })).toBe("acme.com||");
  });

  it("distinguishes different people", () => {
    const k1 = emissionKey({ companyDomain: "acme.com", firstName: "a", lastName: "b" });
    const k2 = emissionKey({ companyDomain: "acme.com", firstName: "a", lastName: "c" });
    expect(k1).not.toBe(k2);
  });
});

describe("selectFreshLeads", () => {
  const lead = (
    domain: string,
    first: string,
    last: string,
    email?: string,
    linkedinUrl?: string
  ) => ({
    companyDomain: domain,
    firstName: first,
    lastName: last,
    email,
    linkedinUrl,
  });

  it("excludes already-emitted leads, keeps fresh ones", () => {
    const page = [
      lead("acme.com", "John", "Doe"),
      lead("acme.com", "Jane", "Roe"),
      lead("beta.com", "Sam", "Smith"),
    ];
    const emitted = new Set([
      emissionKey(lead("acme.com", "john", "doe")), // case-insensitive hit
    ]);
    const fresh = selectFreshLeads(page, emitted);
    expect(fresh).toHaveLength(2);
    expect(fresh.map((l) => l.firstName)).toEqual(["Jane", "Sam"]);
  });

  it("returns all leads when nothing emitted yet (cold start)", () => {
    const page = [lead("acme.com", "John", "Doe")];
    expect(selectFreshLeads(page, new Set())).toHaveLength(1);
  });

  it("returns zero fresh when the whole page is already emitted (saturation)", () => {
    const page = [lead("acme.com", "John", "Doe"), lead("beta.com", "Sam", "Smith")];
    const emitted = new Set(page.map((l) => emissionKey(l)));
    expect(selectFreshLeads(page, emitted)).toHaveLength(0);
  });

  it("excludes gateway-suppressed emails and linkedin urls", () => {
    const page = [
      lead("acme.com", "John", "Doe", "JOHN@ACME.COM", "https://www.linkedin.com/in/john/"),
      lead("beta.com", "Jane", "Roe", "jane@beta.com", "https://linkedin.com/in/jane"),
      lead("gamma.com", "Sam", "Smith", "sam@gamma.com", "https://linkedin.com/in/sam"),
    ];
    const fresh = selectFreshLeads(page, new Set(), {
      excludeEmails: [" john@acme.com "],
      excludeLinkedinUrls: ["linkedin.com/in/jane"],
    });
    expect(fresh.map((l) => l.email)).toEqual(["sam@gamma.com"]);
  });
});

describe("gateway exclusions", () => {
  it("normalizes email casing and whitespace", () => {
    expect(normalizeEmail(" User@Example.COM ")).toBe("user@example.com");
  });

  it("normalizes linkedin scheme, www, query, and trailing slash", () => {
    expect(normalizeLinkedinUrl("https://www.linkedin.com/in/Person/?trk=public")).toBe(
      "linkedin.com/in/person"
    );
  });

  it("matches excluded linkedin variants", () => {
    expect(
      isGatewayExcluded(
        { linkedinUrl: "https://www.linkedin.com/in/served/" },
        { excludeLinkedinUrls: ["linkedin.com/in/served"] }
      )
    ).toBe(true);
  });
});

describe("computePaging", () => {
  it("continues when fresh leads exist and the probe is not exhausted", () => {
    expect(
      computePaging({ freshCount: 100, offset: 0, limit: 100, totalMatched: 5000 })
    ).toEqual({ hasMore: true, nextOffset: 100 });
  });

  it("stops on saturation even when totalMatched is wildly inflated (the bug)", () => {
    // Prod: offset 2900, page of 100 all already-served, probe says 50000.
    expect(
      computePaging({ freshCount: 0, offset: 2900, limit: 100, totalMatched: 50000 })
    ).toEqual({ hasMore: false });
  });

  it("stops when the probe count is exhausted", () => {
    expect(
      computePaging({ freshCount: 100, offset: 4900, limit: 100, totalMatched: 5000 })
    ).toEqual({ hasMore: false });
  });

  it("does NOT prematurely stop on a partial-but-nonzero fresh page", () => {
    // Draining but not dry: fewer fresh than limit, more probe remaining.
    expect(
      computePaging({ freshCount: 30, offset: 200, limit: 100, totalMatched: 5000 })
    ).toEqual({ hasMore: true, nextOffset: 300 });
  });

  it("advances nextOffset by the page size from the current offset", () => {
    expect(
      computePaging({ freshCount: 1, offset: 2800, limit: 1, totalMatched: 99999 })
    ).toEqual({ hasMore: true, nextOffset: 2801 });
  });
});
