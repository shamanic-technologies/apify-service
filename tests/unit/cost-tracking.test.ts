import { describe, it, expect } from "vitest";
import {
  eventCostItems,
  COST_NAME_BY_SOURCE,
  START_COST_BY_SOURCE,
} from "../../src/lib/cost-tracking.js";
import type { ChargedEventsBySource } from "../../src/lib/waterfall.js";

describe("eventCostItems", () => {
  it("maps pipelinelabs start + lead events to actual platform cost items", () => {
    const charged: ChargedEventsBySource = {
      pipelinelabs: { "apify-actor-start": 2, "lead-returned": 5 },
    };
    const items = eventCostItems(charged);
    const byName = Object.fromEntries(items.map((i) => [i.costName, i]));

    expect(byName[START_COST_BY_SOURCE.pipelinelabs].quantity).toBe(2);
    expect(byName[COST_NAME_BY_SOURCE.pipelinelabs].quantity).toBe(5);
    for (const i of items) {
      expect(i.costSource).toBe("platform");
      expect(i.status).toBe("actual");
    }
  });

  it("skips zero-quantity events", () => {
    const items = eventCostItems({
      pipelinelabs: { "apify-actor-start": 0, "lead-returned": 3 },
    });
    expect(items).toHaveLength(1);
    expect(items[0].costName).toBe(COST_NAME_BY_SOURCE.pipelinelabs);
    expect(items[0].quantity).toBe(3);
  });

  it("returns no items for empty charged events", () => {
    expect(eventCostItems({})).toHaveLength(0);
    expect(eventCostItems({ pipelinelabs: {} })).toHaveLength(0);
  });

  it("fails loud on an unmapped Apify event (never silently under-bills)", () => {
    expect(() => eventCostItems({ pipelinelabs: { "mystery-event": 1 } })).toThrow(
      /unmapped Apify charged event/
    );
  });
});
