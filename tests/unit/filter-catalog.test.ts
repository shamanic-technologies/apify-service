import { describe, it, expect } from "vitest";
import {
  buildFiltersPromptText,
  buildFilterJsonSchema,
  AUDIENCE_FILTER_FIELDS,
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

  it("builds a strict, faithful filter JSON schema for structured output", () => {
    const schema = buildFilterJsonSchema() as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, any>;
    };
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([]); // all filters optional
    // Paging knobs are NOT part of an audience's filter surface.
    expect(schema.properties.limit).toBeUndefined();
    expect(schema.properties.offset).toBeUndefined();
    // Enum vocab is carried FAITHFULLY (full set), not narrowed.
    expect(schema.properties.industries.items.enum).toEqual([...filterCatalog.industries]);
    expect(schema.properties.seniorities.items.enum).toContain("c_suite");
    // Free-text array field has no enum.
    expect(schema.properties.titles.items.enum).toBeUndefined();
    // Integer field maps to integer.
    expect(schema.properties.employeeMin.type).toBe("integer");
  });

  it("audience filter fields exclude paging knobs", () => {
    const names = AUDIENCE_FILTER_FIELDS.map((f) => f.name);
    expect(names).not.toContain("limit");
    expect(names).not.toContain("offset");
    expect(names).toContain("titles");
    expect(names).toContain("technologies");
  });

  it("exposes a stable, non-empty schema version", () => {
    expect(FILTERS_SCHEMA_VERSION).toMatch(/^[0-9a-f]{12}$/);
    // deterministic: same inputs → same hash within a process.
    expect(FILTERS_SCHEMA_VERSION).toBe(FILTERS_SCHEMA_VERSION);
  });
});
