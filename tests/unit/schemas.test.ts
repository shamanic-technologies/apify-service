import { describe, it, expect } from "vitest";
import {
  SearchRequestSchema,
  ResolveRequestSchema,
  SearchCountRequestSchema,
} from "../../src/schemas.js";

describe("SearchRequestSchema", () => {
  it("requires limit (no silent default)", () => {
    expect(SearchRequestSchema.safeParse({ titles: ["CMO"] }).success).toBe(false);
  });
  it("accepts a valid filter set", () => {
    const r = SearchRequestSchema.safeParse({
      titles: ["Marketing Director"],
      locationCountries: ["United States"],
      limit: 50,
    });
    expect(r.success).toBe(true);
  });
  it("rejects limit over 1000", () => {
    expect(SearchRequestSchema.safeParse({ limit: 5000 }).success).toBe(false);
  });
  it("accepts optional offset and rich filters (additive)", () => {
    const r = SearchRequestSchema.safeParse({
      limit: 100,
      offset: 200,
      companySizes: ["51-200"],
      revenueRanges: ["1m_10m"],
      fundingStages: ["series_a"],
      technologies: ["HubSpot"],
    });
    expect(r.success).toBe(true);
  });
  it("accepts optional gateway suppression excludes", () => {
    const r = SearchRequestSchema.safeParse({
      limit: 10,
      excludeEmails: ["served@example.com"],
      excludeLinkedinUrls: ["linkedin.com/in/served"],
    });
    expect(r.success).toBe(true);
  });
  it("rejects a negative offset", () => {
    expect(SearchRequestSchema.safeParse({ limit: 50, offset: -1 }).success).toBe(false);
  });
});

describe("SearchCountRequestSchema", () => {
  it("accepts a filter set with no limit (count needs no paging)", () => {
    const r = SearchCountRequestSchema.safeParse({ titles: ["CMO"], industries: ["Banking"] });
    expect(r.success).toBe(true);
  });
  it("accepts an empty filter set", () => {
    expect(SearchCountRequestSchema.safeParse({}).success).toBe(true);
  });
});

describe("ResolveRequestSchema", () => {
  it("rejects empty leads array", () => {
    expect(ResolveRequestSchema.safeParse({ leads: [] }).success).toBe(false);
  });
  it("requires firstName, lastName, companyDomain per lead", () => {
    expect(
      ResolveRequestSchema.safeParse({ leads: [{ firstName: "A", lastName: "B" }] }).success
    ).toBe(false);
  });
  it("accepts valid leads and optional includeInferred", () => {
    const r = ResolveRequestSchema.safeParse({
      leads: [{ firstName: "Dennis", lastName: "Criner", companyDomain: "douglaslabs.com" }],
      includeInferred: true,
    });
    expect(r.success).toBe(true);
  });
});
