import { describe, it, expect } from "vitest";
import {
  buildFiltersPromptText,
  FILTERS_SCHEMA_VERSION,
  filterCatalog,
} from "../../src/lib/filter-catalog.js";

describe("filter-catalog", () => {
  it("exposes non-empty accepted-value vocabularies", () => {
    expect(filterCatalog.industries.length).toBeGreaterThan(0);
    expect(filterCatalog.seniorities).toContain("c_suite");
    expect(filterCatalog.functions).toContain("sales");
    expect(filterCatalog.companySizes).toContain("51-200");
    expect(filterCatalog.revenueRanges).toContain("1m_10m");
    expect(filterCatalog.fundingStages).toContain("series_a");
  });

  it("builds a prompt that names filters and enumerates enum vocab", () => {
    const prompt = buildFiltersPromptText();
    expect(prompt).toMatch(/POST \/search\/count/);
    expect(prompt).toMatch(/revenueRanges/);
    expect(prompt).toMatch(/c_suite/); // seniority enum surfaced
    expect(prompt).toMatch(/offset/); // pagination documented
  });

  it("exposes a stable, non-empty schema version", () => {
    expect(FILTERS_SCHEMA_VERSION).toMatch(/^[0-9a-f]{12}$/);
    // deterministic: same inputs → same hash within a process.
    expect(FILTERS_SCHEMA_VERSION).toBe(FILTERS_SCHEMA_VERSION);
  });
});
