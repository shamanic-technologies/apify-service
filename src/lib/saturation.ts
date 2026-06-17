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
  email?: string | null;
  linkedinUrl?: string | null;
  companyDomain?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};

type GatewayExclusions = {
  excludeEmails?: readonly string[];
  excludeLinkedinUrls?: readonly string[];
};

type NormalizedGatewayExclusions = {
  emails: ReadonlySet<string>;
  linkedinUrls: ReadonlySet<string>;
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

export function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = (email ?? "").trim().toLowerCase();
  return normalized || null;
}

export function normalizeLinkedinUrl(url: string | null | undefined): string | null {
  let normalized = (url ?? "").trim().toLowerCase();
  if (!normalized) return null;
  normalized = normalized
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[?#]/, 1)[0]
    .replace(/\/+$/, "");
  return normalized || null;
}

function normalizedSet(
  values: readonly string[] | undefined,
  normalize: (v: string) => string | null
): Set<string> {
  return new Set((values ?? []).map(normalize).filter((v): v is string => Boolean(v)));
}

function normalizeGatewayExclusions(
  exclusions: GatewayExclusions
): NormalizedGatewayExclusions {
  return {
    emails: normalizedSet(exclusions.excludeEmails, normalizeEmail),
    linkedinUrls: normalizedSet(exclusions.excludeLinkedinUrls, normalizeLinkedinUrl),
  };
}

function isNormalizedGatewayExcluded(
  lead: PersonIdentity,
  exclusions: NormalizedGatewayExclusions
): boolean {
  const email = normalizeEmail(lead.email);
  if (email && exclusions.emails.has(email)) return true;
  const linkedinUrl = normalizeLinkedinUrl(lead.linkedinUrl);
  return Boolean(linkedinUrl && exclusions.linkedinUrls.has(linkedinUrl));
}

export function isGatewayExcluded(
  lead: PersonIdentity,
  exclusions: GatewayExclusions
): boolean {
  return isNormalizedGatewayExcluded(lead, normalizeGatewayExclusions(exclusions));
}

/**
 * Keep only the leads NOT already emitted for this campaign. `emittedKeys` is the
 * set of `emissionKey()`s already present in `lead_emissions` for (org, campaign).
 */
export function selectFreshLeads<T extends PersonIdentity>(
  pageLeads: T[],
  emittedKeys: ReadonlySet<string>,
  exclusions: GatewayExclusions = {}
): T[] {
  const normalizedExclusions = normalizeGatewayExclusions(exclusions);
  return pageLeads.filter(
    (l) =>
      !emittedKeys.has(emissionKey(l)) &&
      !isNormalizedGatewayExcluded(l, normalizedExclusions)
  );
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
