# trusted-leads-service

Verified-email lead provider backed by the **Apify waterfall**. Replaces Apollo for lead search + verified-email acquisition at ~$1.5 per 1,000 verified emails (vs Apollo ~$30–50/1k).

## Why

Apollo's free search masks last names and hides domains; getting a usable lead (name + domain) requires a paid enrichment credit that already includes the email. Apify's structured leads-finders return **name + domain + verified email** in one cheap call — so this service uses them directly.

## Waterfall

| Tier | Actor | Role | Email kind |
|------|-------|------|-----------|
| 1 | `pipelinelabs/lead-scraper-apollo-zoominfo-lusha-ppe` | primary, richest fields | real DB email, `deliverable` |
| 2 | `microworlds/leads-finder` | fallback, different DB | real DB email, `verified`, catch-all flagged |
| 3 | `clearpath/email-finder-api` | **opt-in last resort** (`includeInferred:true`) | pattern + SMTP verify, accepted only `isSafeToSend && !isCatchAll`, tagged `source:"inferred"` |

DB-sourced emails (tiers 1–2) are real and on by default. Pattern-guessed emails (tier 3) are off by default and clearly tagged so they're never silently mixed with verified ones.

## Endpoints

- `POST /search` — search by Apollo-style filters (titles, seniorities, locations, industries, company size, domains, keywords) → verified leads (pipelinelabs ∪ microworlds, deduped by email).
- `POST /resolve` — resolve verified emails for known leads `[{firstName, lastName, companyDomain}]` via the 3-tier waterfall. 12-month cache: a lead already resolved for the org is not re-billed.
- `GET /searches/:runId` — stored leads for a run.
- `GET /health`, `GET /health/debug`, `GET /openapi.json`.

All endpoints (except health/openapi) require `x-org-id` + `x-user-id` headers. Optional run-context: `x-run-id`, `x-brand-id`, `x-campaign-id`, `x-feature-slug`, `x-workflow-slug`.

## Cost tracking

The Apify token is a **platform** key (resolved via key-service `/keys/platform/apify/decrypt`). Every request:
1. `authorize` org affordability (billing-service) on the worst-case quantity.
2. Runs the waterfall.
3. Declares one `actual` cost (`apify-verified-lead`, `costSource:"platform"`, quantity = verified leads delivered) in runs-service. Fail-loud.

> ⚠️ The cost name `apify-verified-lead` must be registered in **costs-service** before prod use, or runs-service 422-rejects the cost declaration.

## Env

See `.env.example`. Required: `TRUSTED_LEADS_SERVICE_DATABASE_URL`, `KEY_SERVICE_URL`/`KEY_SERVICE_API_KEY`, `RUNS_SERVICE_URL`/`RUNS_SERVICE_API_KEY`, `BILLING_SERVICE_URL`/`BILLING_SERVICE_API_KEY`.

## Dev

```bash
pnpm install
pnpm db:generate && pnpm db:migrate
pnpm dev          # tsx watch
pnpm test         # vitest
pnpm build        # tsc + openapi
```
