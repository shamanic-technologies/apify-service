import { describe, it, expect, vi } from "vitest";
import {
  TARGET_MIN_COUNT,
  TARGET_MAX_COUNT,
  MAX_REFINE_ITERATIONS,
  refineFeedback,
  selectBestAttempt,
  validateFilters,
  buildSegmentSystemPrompt,
  buildSegmentMessage,
  buildAudienceFilters,
  type RefineAttempt,
  type BuilderDeps,
} from "../../src/lib/audience-builder.js";
import type { AudienceFilters } from "../../src/schemas.js";

const F = (overrides: Partial<AudienceFilters> = {}): AudienceFilters => ({
  titles: ["CMO"],
  ...overrides,
});

const attempt = (iteration: number, count: number): RefineAttempt => ({
  iteration,
  feedback: null,
  filters: F(),
  count,
  llmRaw: {},
});

describe("refineFeedback", () => {
  it("returns null when count is in the target band", () => {
    expect(refineFeedback(TARGET_MIN_COUNT)).toBeNull();
    expect(refineFeedback(TARGET_MAX_COUNT)).toBeNull();
    expect(refineFeedback(1000)).toBeNull();
  });
  it("asks to broaden when too narrow", () => {
    const fb = refineFeedback(TARGET_MIN_COUNT - 1);
    expect(fb).toMatch(/broaden/i);
  });
  it("asks to narrow when too broad", () => {
    const fb = refineFeedback(TARGET_MAX_COUNT + 1);
    expect(fb).toMatch(/narrow/i);
  });
});

describe("selectBestAttempt", () => {
  it("prefers an in-band attempt", () => {
    const best = selectBestAttempt([attempt(0, 5), attempt(1, 1000), attempt(2, 9_999_999)]);
    expect(best.count).toBe(1000);
  });
  it("falls back to the non-empty attempt closest to the band", () => {
    const best = selectBestAttempt([attempt(0, 1), attempt(1, 40), attempt(2, 9_999_999)]);
    // 40 is distance 10 from MIN(50); 9.99M is way over MAX → 40 wins.
    expect(best.count).toBe(40);
  });
  it("returns the last attempt when every attempt matched nobody", () => {
    const best = selectBestAttempt([attempt(0, 0), attempt(1, 0)]);
    expect(best.iteration).toBe(1);
  });
  it("throws on empty input (fail-loud)", () => {
    expect(() => selectBestAttempt([])).toThrow();
  });
});

describe("validateFilters", () => {
  it("accepts a faithful filter object", () => {
    const v = validateFilters({ titles: ["CEO"], industries: ["Banking"] });
    expect(v.titles).toEqual(["CEO"]);
  });
  it("throws on a non-faithful shape (fail-loud)", () => {
    expect(() => validateFilters({ titles: "not-an-array" })).toThrow();
  });
});

describe("prompt builders", () => {
  it("system prompt embeds the faithful filter contract", () => {
    const p = buildSegmentSystemPrompt();
    expect(p).toMatch(/apify-service accepts the following filters/);
    expect(p).toMatch(/FAITHFUL/);
  });
  it("user message carries feedback + previous filters only on refine", () => {
    const first = buildSegmentMessage({ name: "n", description: "d" }, null, null);
    expect(first).not.toMatch(/Feedback/);
    const refined = buildSegmentMessage({ name: "n", description: "d" }, "broaden", F());
    expect(refined).toMatch(/Feedback: broaden/);
    expect(refined).toMatch(/previous filter set/);
  });
});

describe("buildAudienceFilters (refine loop)", () => {
  it("stops after one iteration when the first count is in band", async () => {
    const llm = vi.fn().mockResolvedValue({ filters: F(), raw: { x: 1 } });
    const count = vi.fn().mockResolvedValue(1000);
    const deps: BuilderDeps = { llm, count };
    const out = await buildAudienceFilters(deps, { name: "n", description: "d" });
    expect(out.count).toBe(1000);
    expect(out.attempts).toHaveLength(1);
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("refines when out of band and feeds the count back", async () => {
    const llm = vi
      .fn()
      .mockResolvedValueOnce({ filters: F({ titles: ["narrow"] }), raw: {} })
      .mockResolvedValueOnce({ filters: F({ titles: ["broad"] }), raw: {} });
    const count = vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(500);
    const deps: BuilderDeps = { llm, count };
    const out = await buildAudienceFilters(deps, { name: "n", description: "d" });
    expect(out.attempts).toHaveLength(2);
    expect(out.count).toBe(500);
    // Second llm call received broadening feedback derived from the first count.
    const secondMessage = llm.mock.calls[1][1] as string;
    expect(secondMessage).toMatch(/broaden/i);
  });

  it("caps iterations and picks the best out-of-band attempt", async () => {
    const llm = vi.fn().mockResolvedValue({ filters: F(), raw: {} });
    // Always too narrow → never in band → loop runs MAX_REFINE_ITERATIONS times.
    const count = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(40)
      .mockResolvedValueOnce(3);
    const deps: BuilderDeps = { llm, count };
    const out = await buildAudienceFilters(deps, { name: "n", description: "d" });
    expect(out.attempts).toHaveLength(MAX_REFINE_ITERATIONS);
    expect(out.count).toBe(40); // closest non-empty to the band
  });
});
