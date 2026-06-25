import { AudienceFiltersSchema, type AudienceFilters } from "../schemas.js";
import { buildFiltersPromptText } from "./filter-catalog.js";

/**
 * Agentic NL-segment → faithful-apify-filters refine loop. Pure orchestration:
 * the LLM call and the count probe are injected, so the loop is unit-testable
 * without hitting chat-service or Apify. The LLM goes through chat-service
 * (it owns the model + cost); the count probe is the existing FREE pipelinelabs
 * countOnly surface — the same one /search/count uses (no run, no cost).
 */

// A "good" B2B audience is neither empty nor unusably broad. The loop nudges the
// LLM toward this band, but never FAILS on an out-of-band count — a valid
// segment may genuinely match few people. The band only drives refinement.
export const TARGET_MIN_COUNT = 50;
export const TARGET_MAX_COUNT = 50_000;
export const MAX_REFINE_ITERATIONS = 3;

export interface RefineAttempt {
  iteration: number;
  feedback: string | null;
  filters: AudienceFilters;
  count: number;
  llmRaw: Record<string, unknown>;
}

export interface BuiltAudience {
  filters: AudienceFilters;
  count: number;
  attempts: RefineAttempt[];
}

/** Validate a raw LLM JSON object as a faithful filter set. Fail-loud. */
export function validateFilters(json: unknown): AudienceFilters {
  const parsed = AudienceFiltersSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `[apify-service] LLM produced an invalid filter object: ${JSON.stringify(
        parsed.error.issues
      ).slice(0, 500)}`
    );
  }
  return parsed.data;
}

/** Stable system prompt: the faithful filter contract + authoring rules. */
export function buildSegmentSystemPrompt(): string {
  return [
    "You convert a natural-language audience description into a FAITHFUL apify-service people-search filter object for B2B lead search.",
    "Output ONLY a JSON object whose keys are a subset of the documented filter fields. Omit any field you do not need.",
    "For enum-constrained fields, use ONLY the accepted values verbatim. Do not invent fields or values.",
    "Prefer a few high-signal filters over many — an over-narrow filter set returns nobody.",
    "",
    buildFiltersPromptText(),
  ].join("\n");
}

/** The per-iteration user message: the segment, plus refinement feedback. */
export function buildSegmentMessage(
  input: { name: string; description: string },
  feedback: string | null,
  previousFilters: AudienceFilters | null
): string {
  const lines = [
    `Audience name: ${input.name}`,
    `Audience description: ${input.description}`,
  ];
  if (feedback && previousFilters) {
    lines.push(
      "",
      `Your previous filter set was: ${JSON.stringify(previousFilters)}`,
      `Feedback: ${feedback}`,
      "Produce an improved filter set.",
    );
  }
  return lines.join("\n");
}

/**
 * Refinement feedback for a count, or null when the count is in the target band
 * (i.e. no further refinement needed). Drives the next iteration's prompt.
 */
export function refineFeedback(count: number): string | null {
  if (count < TARGET_MIN_COUNT) {
    return `The filters matched only ${count} people — too narrow. Broaden them (drop or loosen the most restrictive filters, widen geography/seniority/industry) to reach roughly ${TARGET_MIN_COUNT}–${TARGET_MAX_COUNT} matches.`;
  }
  if (count > TARGET_MAX_COUNT) {
    return `The filters matched ${count} people — too broad. Narrow them (add a more specific title, seniority, industry, or geography) to reach roughly ${TARGET_MIN_COUNT}–${TARGET_MAX_COUNT} matches.`;
  }
  return null;
}

/** Distance from the target band (0 when in-band). */
function bandDistance(count: number): number {
  if (count < TARGET_MIN_COUNT) return TARGET_MIN_COUNT - count;
  if (count > TARGET_MAX_COUNT) return count - TARGET_MAX_COUNT;
  return 0;
}

/**
 * Pick the best attempt: prefer an in-band count; else the non-empty attempt
 * closest to the band; else (every attempt matched nobody) the last attempt.
 */
export function selectBestAttempt(attempts: RefineAttempt[]): RefineAttempt {
  if (attempts.length === 0) {
    throw new Error("[apify-service] no refine attempts to select from");
  }
  const inBand = attempts.find((a) => bandDistance(a.count) === 0);
  if (inBand) return inBand;
  const nonEmpty = attempts.filter((a) => a.count > 0);
  if (nonEmpty.length > 0) {
    return nonEmpty.reduce((best, a) =>
      bandDistance(a.count) < bandDistance(best.count) ? a : best
    );
  }
  return attempts[attempts.length - 1];
}

export interface BuilderDeps {
  /** Call the LLM (chat-service) and return validated filters + the raw response. */
  llm: (
    systemPrompt: string,
    message: string
  ) => Promise<{ filters: AudienceFilters; raw: Record<string, unknown> }>;
  /** Free pipelinelabs countOnly probe for a filter set. */
  count: (filters: AudienceFilters) => Promise<number>;
}

/**
 * Run the refine loop: build filters from the segment, count them, and — while
 * out of the target band and iterations remain — feed the count back to the LLM
 * to broaden/narrow. Returns the best attempt plus the full bronze trail.
 */
export async function buildAudienceFilters(
  deps: BuilderDeps,
  input: { name: string; description: string }
): Promise<BuiltAudience> {
  const systemPrompt = buildSegmentSystemPrompt();
  const attempts: RefineAttempt[] = [];
  let feedback: string | null = null;
  let previousFilters: AudienceFilters | null = null;

  for (let i = 0; i < MAX_REFINE_ITERATIONS; i++) {
    const message = buildSegmentMessage(input, feedback, previousFilters);
    const { filters, raw } = await deps.llm(systemPrompt, message);
    const count = await deps.count(filters);
    attempts.push({ iteration: i, feedback, filters, count, llmRaw: raw });

    feedback = refineFeedback(count);
    previousFilters = filters;
    if (feedback === null) break; // in band — done
  }

  const best = selectBestAttempt(attempts);
  return { filters: best.filters, count: best.count, attempts };
}
