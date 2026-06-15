/**
 * Per-campaign no-repeat + saturation-stop primitives (apify-service#18).
 *
 * The pipelinelabs cursor does NOT short-page at exhaustion — it recycles full
 * pages of already-served leads (prod campaign 1dba3969…: `lead_count == limit`
 * at every offset 200..4100, all already-served). So `totalMatched` (the inflated
 * count probe) can never signal a drained audience. The only reliable terminality
 * signal is "this page produced zero FRESH (not-already-emitted) distinct leads".
 *
 * These helpers are pure so the terminality logic is unit-tested without a DB or
 * Apify; the route wires the emission-log reads/writes around them.
 */

type PersonIdentity = {
  companyDomain?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};

/**
 * Per-campaign no-repeat identity key: (company_domain, first_name, last_name),
 * trimmed + lower-cased. Mirrors the `lead_emissions_key_idx` unique index so an
 * in-memory exclusion matches what the DB would dedup on.
 */
export function emissionKey(l: PersonIdentity): string {
  return [l.companyDomain, l.firstName, l.lastName]
    .map((s) => (s ?? "").trim().toLowerCase())
    .join("|");
}

/**
 * Keep only the leads NOT already emitted for this campaign. `emittedKeys` is the
 * set of `emissionKey()`s already present in `lead_emissions` for (org, campaign).
 */
export function selectFreshLeads<T extends PersonIdentity>(
  pageLeads: T[],
  emittedKeys: ReadonlySet<string>
): T[] {
  return pageLeads.filter((l) => !emittedKeys.has(emissionKey(l)));
}

/**
 * Terminality for /search pagination, driven by FRESH-distinct exhaustion rather
 * than the inflated `totalMatched` probe:
 *   hasMore = freshCount > 0 && consumed < totalMatched
 *
 * `freshCount > 0` is the load-bearing clause: a page yielding zero fresh distinct
 * leads is terminal regardless of how large `totalMatched` claims the pool is. It
 * cannot prematurely terminate a sequence that still has fresh leads — any page
 * containing ≥1 fresh lead continues. The `consumed < totalMatched` clause is kept
 * as the existing probe-exhaustion upper bound.
 */
export function computePaging(args: {
  freshCount: number;
  offset: number;
  limit: number;
  totalMatched: number;
}): { hasMore: boolean; nextOffset?: number } {
  const consumed = args.offset + args.limit;
  const hasMore = args.freshCount > 0 && consumed < args.totalMatched;
  return hasMore ? { hasMore, nextOffset: consumed } : { hasMore };
}
