import { describe, it, expect } from "vitest";
import { actualItemsBySource, COST_NAME_BY_SOURCE } from "../../src/lib/cost-tracking.js";
import type { NormalizedLead } from "../../src/lib/waterfall.js";

const lead = (source: NormalizedLead["source"]): NormalizedLead => ({
  email: `x@${source}.com`,
  emailStatus: "deliverable",
  source,
  isCatchAll: false,
  isInferred: source === "clearpath",
  raw: {},
});

describe("actualItemsBySource", () => {
  it("groups leads into one actual cost item per source actor", () => {
    const items = actualItemsBySource([
      lead("pipelinelabs"),
      lead("pipelinelabs"),
      lead("microworlds"),
      lead("clearpath"),
    ]);
    const byName = Object.fromEntries(items.map((i) => [i.costName, i]));

    expect(byName[COST_NAME_BY_SOURCE.pipelinelabs].quantity).toBe(2);
    expect(byName[COST_NAME_BY_SOURCE.microworlds].quantity).toBe(1);
    expect(byName[COST_NAME_BY_SOURCE.clearpath].quantity).toBe(1);
    for (const i of items) {
      expect(i.costSource).toBe("platform");
      expect(i.status).toBe("actual");
    }
  });

  it("returns no items for an empty lead set", () => {
    expect(actualItemsBySource([])).toHaveLength(0);
  });

  it("uses a distinct cost name per actor", () => {
    const names = new Set(Object.values(COST_NAME_BY_SOURCE));
    expect(names.size).toBe(3);
  });
});
