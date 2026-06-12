import { describe, it, expect } from "vitest";
import { SearchRequestSchema, ResolveRequestSchema } from "../../src/schemas.js";

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
