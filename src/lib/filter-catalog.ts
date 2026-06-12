/**
 * Single source of truth for apify-service's accepted search filters: the
 * accepted-value vocabulary (gap 5) + a stable, versioned LLM-readable filter
 * description (gap 4). Both the `/search/reference` and `/search/filters-prompt`
 * endpoints derive from the constants here, so the version hash changes exactly
 * when the accepted filter surface changes.
 *
 * The enum vocabularies mirror the pipelinelabs actor input schema
 * (`pipelinelabs~lead-scraper-apollo-zoominfo-lusha-ppe`) — the richer of the
 * two verified DB sources, which backs count + pagination.
 */
import { createHash } from "crypto";

// ─── Accepted-value vocabulary (gap 5) ───────────────────────────────────────

export const SENIORITIES = [
  "c_suite",
  "vp",
  "director",
  "manager",
  "senior",
  "entry",
  "owner",
  "partner",
  "intern",
] as const;

export const FUNCTIONS = [
  "engineering",
  "sales",
  "marketing",
  "finance",
  "operations",
  "human_resources",
  "information_technology",
  "business_development",
  "support",
  "education",
  "consulting",
] as const;

/** Company-size buckets (headcount ranges). Distinct from employeeMin/employeeMax. */
export const COMPANY_SIZES = [
  "1-10",
  "11-50",
  "51-200",
  "201-500",
  "501-1000",
  "1001-5000",
  "5001-10000",
  "10001+",
] as const;

export const REVENUE_RANGES = [
  "lt_1m",
  "1m_10m",
  "10m_50m",
  "50m_200m",
  "200m_1b",
  "gt_1b",
] as const;

export const FUNDING_STAGES = [
  "pre_seed",
  "seed",
  "series_a",
  "series_b",
  "series_c",
  "series_d",
  "series_e",
  "series_f",
  "series_g",
  "series_h",
  "private_equity",
  "debt_financing",
  "convertible_note",
  "corporate_round",
  "equity_crowdfunding",
  "grant",
  "secondary_market",
  "post_ipo_debt",
  "post_ipo_equity",
  "initial_public_offering",
  "undisclosed",
] as const;

export const INDUSTRIES = [
  "Accounting",
  "Agriculture",
  "Airlines/Aviation",
  "Animation",
  "Apparel & Fashion",
  "Architecture & Planning",
  "Automotive",
  "Aviation & Aerospace",
  "Banking",
  "Biotechnology",
  "Broadcast Media",
  "Building Materials",
  "Capital Markets",
  "Chemicals",
  "Civil Engineering",
  "Commercial Real Estate",
  "Computer & Network Security",
  "Computer Games",
  "Computer Hardware",
  "Computer Networking",
  "Computer Software",
  "Construction",
  "Consumer Electronics",
  "Consumer Goods",
  "Consumer Services",
  "Defense & Space",
  "Design",
  "E-Learning",
  "Education Management",
  "Electrical/Electronic Manufacturing",
  "Entertainment",
  "Environmental Services",
  "Events Services",
  "Financial Services",
  "Food & Beverages",
  "Food Production",
  "Furniture",
  "Government Administration",
  "Graphic Design",
  "Health, Wellness & Fitness",
  "Higher Education",
  "Hospital & Health Care",
  "Hospitality",
  "Human Resources",
  "Industrial Automation",
  "Information Services",
  "Information Technology & Services",
  "Insurance",
  "Internet",
  "Investment Banking",
  "Investment Management",
  "Law Practice",
  "Legal Services",
  "Leisure, Travel & Tourism",
  "Logistics & Supply Chain",
  "Luxury Goods & Jewelry",
  "Machinery",
  "Management Consulting",
  "Market Research",
  "Marketing & Advertising",
  "Mechanical or Industrial Engineering",
  "Media Production",
  "Medical Devices",
  "Medical Practice",
  "Mental Health Care",
  "Mining & Metals",
  "Non-Profit Organization Management",
  "Oil & Energy",
  "Online Media",
  "Outsourcing/Offshoring",
  "Pharmaceuticals",
  "Photography",
  "Professional Training & Coaching",
  "Public Relations & Communications",
  "Publishing",
  "Real Estate",
  "Recreation & Sports",
  "Renewables & Environment",
  "Research",
  "Restaurants",
  "Retail",
  "Security & Investigations",
  "Semiconductors",
  "Staffing & Recruiting",
  "Telecommunications",
  "Transportation/Trucking/Railroad",
  "Utilities",
  "Venture Capital & Private Equity",
  "Warehousing",
  "Wholesale",
  "Wine & Spirits",
  "Wireless",
  "Writing & Editing",
] as const;

/** The accepted-vocabulary reference returned by `GET /search/reference` (gap 5). */
export const filterCatalog = {
  industries: INDUSTRIES,
  seniorities: SENIORITIES,
  functions: FUNCTIONS,
  companySizes: COMPANY_SIZES,
  revenueRanges: REVENUE_RANGES,
  fundingStages: FUNDING_STAGES,
} as const;

// ─── Filter-shape description (gap 4) ────────────────────────────────────────

interface FilterFieldDoc {
  name: string;
  type: "string[]" | "number" | "integer";
  description: string;
  /** When the field is constrained to an enum, the accepted values. */
  enum?: readonly string[];
}

/**
 * The accepted `/search` (and `/search/count`) filter fields, with their type
 * and — for enum-constrained fields — their vocabulary. This drives the
 * LLM-facing prompt AND the version hash.
 */
export const FILTER_FIELDS: FilterFieldDoc[] = [
  { name: "titles", type: "string[]", description: "Job titles to include (free text)." },
  { name: "seniorities", type: "string[]", description: "Seniority levels to include.", enum: SENIORITIES },
  { name: "functions", type: "string[]", description: "Department / function to include.", enum: FUNCTIONS },
  { name: "locationCountries", type: "string[]", description: "Person country (free text)." },
  { name: "locationStates", type: "string[]", description: "Person state / region (free text)." },
  { name: "locationCities", type: "string[]", description: "Person city (free text)." },
  { name: "companyNames", type: "string[]", description: "Company names to include (free text)." },
  { name: "industries", type: "string[]", description: "Company industries to include.", enum: INDUSTRIES },
  { name: "companyDomains", type: "string[]", description: "Company domains to include, e.g. acme.com." },
  { name: "keywords", type: "string[]", description: "Company keywords to include (free text)." },
  { name: "companySizes", type: "string[]", description: "Company headcount buckets to include.", enum: COMPANY_SIZES },
  { name: "revenueRanges", type: "string[]", description: "Company annual-revenue buckets to include.", enum: REVENUE_RANGES },
  { name: "fundingStages", type: "string[]", description: "Company funding stages to include.", enum: FUNDING_STAGES },
  { name: "technologies", type: "string[]", description: "Technologies the company uses, e.g. Salesforce, HubSpot (free text)." },
  { name: "employeeMin", type: "integer", description: "Custom company-size minimum (alternative to companySizes buckets)." },
  { name: "employeeMax", type: "integer", description: "Custom company-size maximum (alternative to companySizes buckets)." },
  { name: "limit", type: "integer", description: "Max leads per page, 1–1000. Required on /search; omit on /search/count." },
  { name: "offset", type: "integer", description: "Resume position for pagination past the first page (0-based). Routed to the pipelinelabs source only." },
];

/** Build the human/LLM-readable filter-shape prompt (gap 4). Deterministic. */
export function buildFiltersPromptText(): string {
  const lines: string[] = [];
  lines.push(
    "apify-service accepts the following filters for POST /search and POST /search/count.",
    "All filter fields are optional and combine with AND semantics. Array fields include (OR) the listed values.",
    "Verified-email leads are returned (real database emails); inferred emails are opt-in via /resolve only.",
    "",
    "Filters:",
  );
  for (const f of FILTER_FIELDS) {
    const head = `- ${f.name} (${f.type}): ${f.description}`;
    if (f.enum) {
      lines.push(`${head} Accepted values: ${f.enum.join(", ")}.`);
    } else {
      lines.push(head);
    }
  }
  lines.push(
    "",
    "Notes:",
    "- POST /search/count returns the total matching count for a filter set with zero credit spend and zero persistence.",
    "- POST /search returns a page of leads plus totalMatched / hasMore / nextOffset so you can tell whether more results exist.",
    "- Pagination past the first page (offset > 0) is served by the pipelinelabs source only.",
  );
  return lines.join("\n");
}

/**
 * Stable version of the accepted-filter surface. Derived from the filter-field
 * definitions + enum vocabularies, so the hash changes exactly when the
 * accepted filters change. Callers cache the prompt by this version.
 */
export const FILTERS_SCHEMA_VERSION: string = createHash("sha256")
  .update(JSON.stringify({ fields: FILTER_FIELDS, catalog: filterCatalog }))
  .digest("hex")
  .slice(0, 12);
