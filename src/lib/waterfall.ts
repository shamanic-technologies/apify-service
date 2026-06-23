import { runActor } from "./apify-client.js";

// Actor ids (tilde form for the Apify API path).
export const ACTOR_PIPELINELABS = "pipelinelabs~lead-scraper-apollo-zoominfo-lusha-ppe";
export const ACTOR_MICROWORLDS = "microworlds~leads-finder";
export const ACTOR_CLEARPATH = "clearpath~email-finder-api";
// Email-VERIFICATION actor (input = existing addresses, output = per-email
// deliverability verdict). Distinct from the lead-FINDER actors above: it takes
// an `emails` list, not name+domain. PAY_PER_EVENT — one per-email event, no
// actor-start. bounceverify runs SMTP + catch-all on its OWN backend
// (bounceverify.com), so it does real mailbox verification — unlike Apify-infra
// SMTP actors that hit the platform's port-25 block and degrade to MX guessing.
export const ACTOR_EMAIL_VERIFIER = "bounceverify~bounceverify-email-verifier";

export interface SearchFilters {
  titles?: string[];
  seniorities?: string[];
  functions?: string[];
  locationCountries?: string[];
  locationStates?: string[];
  locationCities?: string[];
  companyNames?: string[];
  industries?: string[];
  companyDomains?: string[];
  keywords?: string[];
  // Rich filters (pipelinelabs-backed; absent on microworlds).
  companySizes?: string[];
  revenueRanges?: string[];
  fundingStages?: string[];
  technologies?: string[];
  employeeMin?: number;
  employeeMax?: number;
  limit: number;
  /** Resume position for pagination past the first page (pipelinelabs only). */
  offset?: number;
}

/** Count-only filter set: same filters as a search, minus paging fields. */
export type CountFilters = Omit<SearchFilters, "limit" | "offset">;

export interface LeadInput {
  firstName: string;
  lastName: string;
  companyDomain: string;
}

export type LeadSource = "pipelinelabs" | "microworlds" | "clearpath";

/**
 * Sources currently wired into the live waterfall. pipelinelabs is the ONLY
 * actor whose Apify pay-per-event pricing cleanly matches our per-lead billing
 * (start ~$0.00001/run + $0.001/lead, both passed through 100%). microworlds
 * ($0.05/run start) and clearpath (per-pattern-tested, hit OR miss) bill events
 * we don't refacture today, so they're disabled until their economics + cost
 * names are sorted.
 *
 * To RE-ENABLE a source, all three must be done together:
 *   1. add it here,
 *   2. register its actor-start + per-event cost names in costs-service
 *      (see COST_NAME_BY_EVENT in cost-tracking.ts) — else provision 422s,
 *   3. extend the worst-case PROVISION in routes/search.ts to cover it.
 */
export const ENABLED_SOURCES: readonly LeadSource[] = ["pipelinelabs"];

/**
 * Number of Apify actor RUNS we executed per source — the basis for billing the
 * per-run `actor-start` fee (100% passthrough: one start charged per run).
 *
 * We count runs OURSELVES rather than reading the run's `chargedEventCounts`,
 * because that field is unreliable for these actors — it comes back `null` /
 * empty even when Apify did charge per-lead + per-start (verified live
 * 2026-06-14: a run with `usageTotalUsd: 0.10001` = start + 100 leads still
 * reports `chargedEventCounts: null`). Leads are billed from the delivered count
 * (see cost-tracking.actualItemsBySource); runs are billed from this count.
 */
export type RunsBySource = Partial<Record<LeadSource, number>>;

export interface NormalizedLead {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  title?: string;
  seniority?: string;
  email: string;
  emailStatus: string; // "deliverable" | "verified" | "inferred"
  source: LeadSource;
  isCatchAll: boolean;
  isInferred: boolean;
  linkedinUrl?: string;
  city?: string;
  state?: string;
  country?: string;
  companyName?: string;
  companyDomain?: string;
  companyIndustry?: string;
  companySize?: number;
  companyLinkedinUrl?: string;
  raw: Record<string, unknown>;
}

// ─── helpers ───────────────────────────────────────────────────────────────

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Drop undefined / empty-array keys so Apify doesn't choke on empty filters. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

const dedupKey = (l: { email: string }) => l.email.toLowerCase();

/** Run `fn` over items with bounded concurrency. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── mappers ─────────────────────────────────────────────────────────────────

function mapPipelinelabs(row: Record<string, unknown>): NormalizedLead | null {
  const email = str(row.email);
  if (!email) return null;
  const industry = Array.isArray(row.companyIndustry)
    ? str((row.companyIndustry as unknown[])[0])
    : str(row.companyIndustry);
  return {
    firstName: str(row.firstName),
    lastName: str(row.lastName),
    fullName: str(row.fullName),
    title: str(row.title),
    seniority: str(row.seniority),
    email,
    emailStatus: str(row.emailStatus) || "deliverable",
    source: "pipelinelabs",
    isCatchAll: false,
    isInferred: false,
    linkedinUrl: str(row.linkedinUrl),
    city: str(row.personCity),
    state: str(row.personState),
    country: str(row.personCountry),
    companyName: str(row.companyName),
    companyDomain: str(row.companyDomain),
    companyIndustry: industry,
    companySize: num(row.companySize),
    companyLinkedinUrl: str(row.companyLinkedinUrl),
    raw: row,
  };
}

function mapMicroworlds(row: Record<string, unknown>): NormalizedLead | null {
  const email = str(row.email);
  if (!email) return null;
  const first = str(row.first_name);
  const last = str(row.last_name);
  return {
    firstName: first,
    lastName: last,
    fullName: [first, last].filter(Boolean).join(" ") || undefined,
    title: str(row.title),
    seniority: undefined,
    email,
    emailStatus: "verified",
    source: "microworlds",
    isCatchAll: Boolean(row.domain_is_catchall),
    isInferred: false,
    linkedinUrl: str(row.linkedin_url),
    city: str(row.city),
    state: str(row.state),
    country: str(row.country),
    companyName: str(row.organization_name),
    companyDomain: str(row.organization_primary_domain) || str(row.organization_website_url),
    companyIndustry: undefined,
    companySize: undefined,
    companyLinkedinUrl: str(row.organization_linkedin_url),
    raw: row,
  };
}

/** clearpath: accept only safe-to-send, non-catch-all guesses. Tagged inferred. */
function mapClearpath(row: Record<string, unknown>): NormalizedLead | null {
  const email = str(row.email);
  if (!email) return null;
  if (!row.isSafeToSend || row.isCatchAll) return null;
  const first = str(row.firstName);
  const last = str(row.surname);
  return {
    firstName: first,
    lastName: last,
    fullName: [first, last].filter(Boolean).join(" ") || undefined,
    title: undefined,
    seniority: undefined,
    email,
    emailStatus: "inferred",
    source: "clearpath",
    isCatchAll: false,
    isInferred: true,
    companyDomain: str(row.domain),
    raw: row,
  };
}

// ─── input builders ──────────────────────────────────────────────────────────

/** Shared pipelinelabs filter map (no paging / no run-mode keys). */
function plFilterInput(f: CountFilters): Record<string, unknown> {
  return compact({
    personTitleIncludes: f.titles,
    seniorityIncludes: f.seniorities,
    functionIncludes: f.functions,
    personLocationCountryIncludes: f.locationCountries,
    personLocationStateIncludes: f.locationStates,
    personLocationCityIncludes: f.locationCities,
    companyNameIncludes: f.companyNames,
    companyIndustryIncludes: f.industries,
    companyDomainIncludes: f.companyDomains,
    companyKeywordIncludes: f.keywords,
    companySizeIncludes: f.companySizes,
    annualRevenueIncludes: f.revenueRanges,
    fundingStageIncludes: f.fundingStages,
    technologiesIncludes: f.technologies,
    companyEmployeeMin: f.employeeMin,
    companyEmployeeMax: f.employeeMax,
    hasEmail: true,
    // Actor enum is "verified" / "unverified" only — "deliverable" 400s
    // (invalid-input). Verified-only guarantee maps to ["verified"].
    emailStatusIncludes: ["verified"],
  });
}

export function plSearchInput(f: SearchFilters): Record<string, unknown> {
  return compact({
    ...plFilterInput(f),
    totalResults: f.limit,
    // Explicit cursor: we own pagination via customOffset. dontSaveProgress
    // avoids polluting the actor's shared-key saved progress (two orgs with
    // identical filters would otherwise resume each other's position).
    customOffset: f.offset,
    dontSaveProgress: f.offset !== undefined ? true : undefined,
  });
}

/** pipelinelabs count-only input: returns the match count, extracts no leads, no charge. */
export function plCountInput(f: CountFilters): Record<string, unknown> {
  return compact({ ...plFilterInput(f), countOnly: true });
}

function mwSearchInput(f: SearchFilters): Record<string, unknown> {
  return compact({
    contact_job_titles: f.titles,
    contact_location: f.locationCountries,
    company_industry: f.industries,
    company_domains: f.companyDomains,
    keywords: f.keywords,
    email_status: ["verified"],
    contact_email_exclude_catch_all_domains: true,
    max_result: f.limit,
  });
}

// ─── orchestration ─────────────────────────────────────────────────────────────

export interface WaterfallResult {
  leads: NormalizedLead[];
  /** Apify usage in USD across all actor runs (observability, not billing). */
  apifyUsdSpent: number;
  /** Runs executed per source — basis for the per-run actor-start cost. */
  runsBySource: RunsBySource;
}

export interface SearchResult extends WaterfallResult {
  /**
   * Total leads matching the filter set across the pipelinelabs source
   * (the count probe), independent of the returned page. Lets the caller tell
   * whether more results exist beyond the page. pipelinelabs-only signal.
   */
  totalMatched: number;
}

// Candidate keys an actor count-row may carry, in priority order.
const COUNT_KEYS = [
  "count",
  "totalCount",
  "total_count",
  "total",
  "matchCount",
  "match_count",
  "totalResults",
  "total_results",
  "availableCount",
  "available_count",
  "leadCount",
  "lead_count",
  "matches",
];

/**
 * Parse a match count from a pipelinelabs `countOnly` dataset. The actor's
 * count-row field name isn't contractually documented, so we scan known keys,
 * then fall back to a sole numeric field. Fail-loud if no count is found.
 */
export function extractCount(items: Array<Record<string, unknown>>): number {
  for (const row of items) {
    for (const k of COUNT_KEYS) {
      const v = row[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
        return Number(v);
      }
    }
  }
  // Fallback: a single row whose only numeric value is the count.
  for (const row of items) {
    const nums = Object.values(row).filter(
      (v) => typeof v === "number" && Number.isFinite(v)
    ) as number[];
    if (nums.length === 1) return nums[0];
  }
  throw new Error(
    `[apify-service] countOnly run returned no recognizable count field. Rows: ${JSON.stringify(
      items
    ).slice(0, 500)}`
  );
}

/**
 * COUNT: how many leads match the filter set, via the pipelinelabs `countOnly`
 * mode — no leads extracted, no charge ("$0.00001 per run, effectively
 * nothing"). Used by POST /search/count (no run / no cost / no persistence) and
 * as the totalMatched probe inside searchVerifiedLeads.
 */
export async function countMatches(
  token: string,
  filters: CountFilters
): Promise<number> {
  const r = await runActor(token, ACTOR_PIPELINELABS, plCountInput(filters));
  return extractCount(r.items);
}

function dedupe(leads: NormalizedLead[]): NormalizedLead[] {
  const seen = new Set<string>();
  const out: NormalizedLead[] = [];
  for (const l of leads) {
    const k = dedupKey(l);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

/**
 * SEARCH: pull verified-email leads matching the filter set, cheapest-source
 * first and sequential by COST — never pay two sources for the same page.
 *
 * Today only pipelinelabs runs (ENABLED_SOURCES): one extraction run (capped at
 * `limit` — we never extract/bill more than requested) plus a near-free
 * countOnly probe for `totalMatched`. microworlds only joins page 1 IF it is
 * re-enabled. Every Apify run's charged events are aggregated and returned for
 * 100% passthrough billing (actor-start + lead-returned).
 */
export async function searchVerifiedLeads(
  token: string,
  filters: SearchFilters
): Promise<SearchResult> {
  const paginating = filters.offset !== undefined && filters.offset > 0;
  // microworlds has no offset support, so it could only ever join page 1.
  const runMicroworlds = ENABLED_SOURCES.includes("microworlds") && !paginating;

  const [pl, countRun, mw] = await Promise.all([
    runActor(token, ACTOR_PIPELINELABS, plSearchInput(filters)),
    // Run the countOnly probe directly (not via countMatches) so its actor-start
    // run is counted and billed through too.
    runActor(token, ACTOR_PIPELINELABS, plCountInput(filters)),
    runMicroworlds
      ? runActor(token, ACTOR_MICROWORLDS, mwSearchInput(filters))
      : Promise.resolve({ items: [], chargedEventCounts: {}, usageTotalUsd: 0 }),
  ]);

  // Two pipelinelabs runs (extraction + count probe), each a billable start.
  const runsBySource: RunsBySource = { pipelinelabs: 2 };
  if (runMicroworlds) runsBySource.microworlds = 1;

  // Cap to exactly `limit`: never return or bill more leads than requested.
  const leads = dedupe([
    ...pl.items.map(mapPipelinelabs).filter((x): x is NormalizedLead => x !== null),
    ...mw.items.map(mapMicroworlds).filter((x): x is NormalizedLead => x !== null),
  ]).slice(0, filters.limit);

  return {
    leads,
    apifyUsdSpent: pl.usageTotalUsd + countRun.usageTotalUsd + mw.usageTotalUsd,
    totalMatched: extractCount(countRun.items),
    runsBySource,
  };
}

// ─── email verification ───────────────────────────────────────────────────────

/**
 * Normalized deliverability verdict. The locked apify-service ↔ outlets-service
 * contract: exactly one of these five literals per input email.
 */
export type VerifyStatus = "valid" | "invalid" | "risky" | "catch_all" | "unknown";

export interface EmailVerdict {
  email: string;
  status: VerifyStatus;
}

export interface VerifyResult {
  verdicts: EmailVerdict[];
  /**
   * Count of DECISIVE verification rows the actor returned — the billable
   * per-email unit. bounceverify charges only for decisive results (it does NOT
   * charge for `unknown` / inconclusive rows), so we bill the decisive count,
   * not every returned row.
   */
  billableCount: number;
  /** Apify usage in USD (observability, not billing). */
  apifyUsdSpent: number;
}

/**
 * Map one bounceverify dataset row → the 5-literal deliverability status.
 *
 * bounceverify's `status` enum is `valid | invalid | risky | unknown`, with
 * catch-all signalled separately via `is_catch_all` (true = the domain accepts
 * any address, so the specific mailbox is unconfirmable) and spam-traps via
 * `is_spamtrap`. Fold those onto our 5-literal contract enum:
 *   - invalid (bad syntax / no MX / SMTP "mailbox does not exist") is terminal → "invalid"
 *   - a catch-all domain → "catch_all" (consumer treats as not-send)
 *   - a spam-trap → "risky" (reachable but toxic to send to)
 *   - valid / risky / unknown pass through; any unrecognized value → "unknown"
 */
export function mapVerifyStatus(row: Record<string, unknown>): VerifyStatus {
  const raw = typeof row.status === "string" ? row.status.trim().toLowerCase() : "";
  const catchAll = row.is_catch_all === true;
  const spamtrap = row.is_spamtrap === true;

  // Invalid is terminal — no MX / bad syntax / mailbox doesn't exist; catch-all moot.
  if (raw === "invalid") return "invalid";
  // Catch-all domain: individual mailbox existence can't be confirmed → not-send.
  if (catchAll) return "catch_all";
  // Spam-trap: deliverable but sending tanks sender reputation → not-send.
  if (spamtrap) return "risky";
  switch (raw) {
    case "valid":
      return "valid";
    case "risky":
      return "risky";
    case "unknown":
      return "unknown";
    default:
      return "unknown";
  }
}

/**
 * VERIFY: take arbitrary email addresses and return a per-email deliverability
 * verdict via the bounceverify actor (real SMTP + catch-all on its own backend).
 *
 * One verdict per INPUT email, matched case-insensitively to the actor's
 * normalized `email` output; an input the actor returns no row for resolves to
 * "unknown" (never dropped — the contract is one result per input email). The
 * actor charges per DECISIVE email (no actor-start, no charge for `unknown`), so
 * `billableCount` (decisive rows) is the billable per-email unit.
 */
export async function verifyEmails(
  token: string,
  emails: string[]
): Promise<VerifyResult> {
  const r = await runActor(token, ACTOR_EMAIL_VERIFIER, { emails });

  // Index actor rows by normalized email (the actor lowercases/trims its `email`).
  const byEmail = new Map<string, Record<string, unknown>>();
  let billableCount = 0;
  for (const row of r.items) {
    const e = typeof row.email === "string" ? row.email.trim().toLowerCase() : "";
    if (!e) continue;
    // bounceverify bills only decisive results — an `unknown` row is free.
    const st = typeof row.status === "string" ? row.status.trim().toLowerCase() : "";
    if (st && st !== "unknown") billableCount++;
    if (!byEmail.has(e)) byEmail.set(e, row);
  }

  const verdicts: EmailVerdict[] = emails.map((email) => {
    const row = byEmail.get(email.trim().toLowerCase());
    return { email, status: row ? mapVerifyStatus(row) : "unknown" };
  });

  return { verdicts, billableCount, apifyUsdSpent: r.usageTotalUsd };
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * RESOLVE: given explicit leads (name + domain), find a verified email via the
 * waterfall:
 *   tier 1 — pipelinelabs name+domain lookup (real DB email)
 *   tier 2 — microworlds by domain, matched on name (real DB email)
 *   tier 3 — clearpath pattern+SMTP verify (inferred, opt-in only)
 * Returns one NormalizedLead per resolved input; unresolved inputs are omitted.
 */
export async function resolveEmails(
  token: string,
  inputs: LeadInput[],
  includeInferred: boolean
): Promise<WaterfallResult> {
  let apifyUsd = 0;
  // tier 1 runs pipelinelabs once per input (a billable start each).
  const runsBySource: RunsBySource = { pipelinelabs: inputs.length };
  const resolved = new Map<number, NormalizedLead>();
  const keyOf = (i: LeadInput) => `${norm(i.firstName)}|${norm(i.lastName)}|${norm(i.companyDomain)}`;

  // tier 1: pipelinelabs per lead (bounded concurrency). pipelinelabs actor-start
  // is ~$0.00001 so a run-per-lead is cheap here (NOT true of the other actors).
  await mapPool(inputs, 8, async (lead, idx) => {
    const r = await runActor(token, ACTOR_PIPELINELABS, {
      personFirstNameIncludes: [lead.firstName],
      personLastNameIncludes: [lead.lastName],
      companyDomainIncludes: [lead.companyDomain],
      hasEmail: true,
      totalResults: 5,
    });
    apifyUsd += r.usageTotalUsd;
    const match = r.items
      .map(mapPipelinelabs)
      .find(
        (l): l is NormalizedLead =>
          l !== null && (!l.lastName || norm(l.lastName) === norm(lead.lastName))
      );
    if (match) resolved.set(idx, match);
  });

  // tier 2: microworlds by domain for the misses, matched on name. DISABLED
  // unless re-enabled — its $0.05/run actor-start makes per-domain runs costly.
  if (ENABLED_SOURCES.includes("microworlds")) {
    const missesT1 = inputs.map((l, i) => ({ l, i })).filter(({ i }) => !resolved.has(i));
    const domains = [...new Set(missesT1.map(({ l }) => l.companyDomain))];
    if (domains.length > 0) {
      runsBySource.microworlds = domains.length; // one run per domain
      const byDomain = new Map<string, NormalizedLead[]>();
      await mapPool(domains, 8, async (domain) => {
        const r = await runActor(token, ACTOR_MICROWORLDS, {
          company_domains: [domain],
          email_status: ["verified"],
          contact_email_exclude_catch_all_domains: true,
          max_result: 25,
        });
        apifyUsd += r.usageTotalUsd;
        byDomain.set(
          domain,
          r.items.map(mapMicroworlds).filter((x): x is NormalizedLead => x !== null)
        );
      });
      for (const { l, i } of missesT1) {
        const cand = (byDomain.get(l.companyDomain) || []).find(
          (c) =>
            norm(c.firstName || "") === norm(l.firstName) &&
            norm(c.lastName || "") === norm(l.lastName)
        );
        if (cand) resolved.set(i, cand);
      }
    }
  }

  // tier 3 (opt-in): clearpath inferred email for whatever remains. DISABLED
  // unless re-enabled — it bills per pattern TESTED (hit or miss), not per email
  // found, so it under-refactures under the per-delivered-lead model.
  if (includeInferred && ENABLED_SOURCES.includes("clearpath")) {
    const missesT2 = inputs.map((l, i) => ({ l, i })).filter(({ i }) => !resolved.has(i));
    if (missesT2.length > 0) {
      runsBySource.clearpath = 1; // single batched clearpath run
      const r = await runActor(token, ACTOR_CLEARPATH, {
        people: missesT2.map(({ l }) => ({
          firstName: l.firstName,
          surname: l.lastName,
          domain: l.companyDomain,
        })),
        mode: "optimized",
      });
      apifyUsd += r.usageTotalUsd;
      const byKey = new Map<string, NormalizedLead>();
      for (const row of r.items) {
        const m = mapClearpath(row);
        if (!m) continue;
        const k = `${norm(m.firstName || "")}|${norm(m.lastName || "")}|${norm(m.companyDomain || "")}`;
        if (!byKey.has(k)) byKey.set(k, m);
      }
      for (const { l, i } of missesT2) {
        const m = byKey.get(keyOf(l));
        if (m) resolved.set(i, m);
      }
    }
  }

  const leads = [...resolved.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, l]) => l);
  return { leads, apifyUsdSpent: apifyUsd, runsBySource };
}
