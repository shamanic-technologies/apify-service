import { describe, it, expect } from "vitest";
import {
  actualItemsBySource,
  startItemsBySource,
  COST_NAME_BY_SOURCE,
  START_COST_BY_SOURCE,
} from "../../src/lib/cost-tracking.js";
import type { NormalizedLead } from "../../src/lib/waterfall.js";

const lead = (source: NormalizedLead["source"]): NormalizedLead => ({
  email: `x@${source}.com`,
  emailStatus: "deliverable",
  source,
  isCatchAll: false,
  isInferred: source === "clearpath",
  raw: {},
});

describe("actualItemsBySource (per delivered lead)", () => {
  it("groups leads into one actual cost item per source actor", () => {
    const items = actualItemsBySource([
      lead("pipelinelabs"),
      lead("pipelinelabs"),
      lead("microworlds"),
    ]);
    const byName = Object.fromEntries(items.map((i) => [i.costName, i]));
    expect(byName[COST_NAME_BY_SOURCE.pipelinelabs].quantity).toBe(2);
    expect(byName[COST_NAME_BY_SOURCE.microworlds].quantity).toBe(1);
    for (const i of items) {
      expect(i.costSource).toBe("platform");
      expect(i.status).toBe("actual");
    }
  });

  it("returns no items for an empty lead set", () => {
    expect(actualItemsBySource([])).toHaveLength(0);
  });
});

describe("startItemsBySource (per run executed)", () => {
  it("emits one actual actor-start item per source with its run count", () => {
    const items = startItemsBySource({ pipelinelabs: 2 });
    expect(items).toHaveLength(1);
    expect(items[0].costName).toBe(START_COST_BY_SOURCE.pipelinelabs);
    expect(items[0].quantity).toBe(2);
    expect(items[0].costSource).toBe("platform");
    expect(items[0].status).toBe("actual");
  });

  it("skips sources with zero runs", () => {
    expect(startItemsBySource({ pipelinelabs: 0 })).toHaveLength(0);
    expect(startItemsBySource({})).toHaveLength(0);
  });
});
