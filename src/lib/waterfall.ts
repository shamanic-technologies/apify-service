import { runActor } from "./apify-client.js";

// Actor ids (tilde form for the Apify API path).
export const ACTOR_PIPELINELABS = "pipelinelabs~lead-scraper-apollo-zoominfo-lusha-ppe";
export const ACTOR_MICROWORLDS = "microworlds~leads-finder";
export const ACTOR_CLEARPATH = "clearpath~email-finder-api";

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
  employeeMin?: number;
  employeeMax?: number;
  limit: number;
}

export interface LeadInput {
  firstName: string;
  lastName: string;
  companyDomain: string;
}

export type LeadSource = "pipelinelabs" | "microworlds" | "clearpath";

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

function plSearchInput(f: SearchFilters): Record<string, unknown> {
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
    companyEmployeeMin: f.employeeMin,
    companyEmployeeMax: f.employeeMax,
    hasEmail: true,
    emailStatusIncludes: ["deliverable"],
    totalResults: f.limit,
  });
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
 * SEARCH: run both verified-only DB sources (pipelinelabs + microworlds) for the
 * same filters in parallel, normalize, dedupe by email. Both return real
 * database emails with a verification status — no pattern-guessing here.
 */
export async function searchVerifiedLeads(
  token: string,
  filters: SearchFilters
): Promise<WaterfallResult> {
  const [pl, mw] = await Promise.all([
    runActor(token, ACTOR_PIPELINELABS, plSearchInput(filters)),
    runActor(token, ACTOR_MICROWORLDS, mwSearchInput(filters)),
  ]);
  const leads = dedupe([
    ...pl.items.map(mapPipelinelabs).filter((x): x is NormalizedLead => x !== null),
    ...mw.items.map(mapMicroworlds).filter((x): x is NormalizedLead => x !== null),
  ]);
  return { leads, apifyUsdSpent: pl.usageTotalUsd + mw.usageTotalUsd };
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
  const resolved = new Map<number, NormalizedLead>();
  const keyOf = (i: LeadInput) => `${norm(i.firstName)}|${norm(i.lastName)}|${norm(i.companyDomain)}`;

  // tier 1: pipelinelabs per lead (bounded concurrency).
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

  // tier 2: microworlds by domain for the misses, matched on name.
  const missesT1 = inputs.map((l, i) => ({ l, i })).filter(({ i }) => !resolved.has(i));
  const domains = [...new Set(missesT1.map(({ l }) => l.companyDomain))];
  if (domains.length > 0) {
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

  // tier 3 (opt-in): clearpath inferred email for whatever remains.
  if (includeInferred) {
    const missesT2 = inputs.map((l, i) => ({ l, i })).filter(({ i }) => !resolved.has(i));
    if (missesT2.length > 0) {
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
  return { leads, apifyUsdSpent: apifyUsd };
}
