# Project: apify-service

Verified-email lead provider backed by the Apify waterfall (pipelinelabs + microworlds DB sources, clearpath inferred fallback). Replaces Apollo for lead search + verified email. Cost tracking via runs-service, platform Apify key via key-service.

## Commands

- `pnpm test` — Vitest
- `pnpm run build` — tsc + generate OpenAPI
- `pnpm run dev` — local dev (tsx watch)
- `pnpm run generate:openapi` — regenerate openapi.json
- `pnpm run db:generate` / `db:migrate` — Drizzle migrations

## Architecture

- `src/schemas.ts` — Zod schemas + OpenAPI registry (source of truth)
- `src/routes/search.ts` — `POST /search`, `POST /resolve`, `GET /searches/:runId`
- `src/routes/health.ts` — health checks
- `src/middleware/auth.ts` — serviceAuth (x-org-id + x-user-id, optional run-context headers)
- `src/lib/apify-client.ts` — generic Apify run+poll runner (banner-row tolerant)
- `src/lib/waterfall.ts` — actor inputs/mappers + search & 3-tier resolve orchestration
- `src/lib/keys-client.ts` — platform Apify key via key-service
- `src/lib/runs-client.ts` — run + cost tracking (createRun, addCosts, updateCostStatus, updateRun)
- `src/lib/cost-tracking.ts` — per-actor cost names + provision→authorize / actualize→cancel helpers
- `src/lib/billing-client.ts` — affordability authorize
- `src/db/schema.ts` — `lead_searches` + `leads` (leads doubles as 12-month cache)

## Conventions

- TypeScript strict, ESM (NodeNext), pnpm, Express 4 + `express-async-errors`, Zod 4 + zod-to-openapi v8, Drizzle (postgres-js), Vitest.
- Fail-loud: no swallowed errors, no silent fallbacks, no `.default()` on Zod.
- Log prefix `[apify-service]`.
- Migrations auto-run at boot; SQL is idempotent (`IF NOT EXISTS`).
- The Apify token is a PLATFORM key. Cost is tracked PER ACTOR (provision→authorize→execute→actualize, fail-loud): `apify-pipelinelabs-lead`, `apify-microworlds-lead`, `apify-clearpath-lead` (all must exist in costs-service or the provision 422s before spend).
- Verified = real DB email (tiers 1–2). Inferred = clearpath pattern-guess (tier 3, opt-in, tagged `source:"inferred"`). Never mix silently.

## Actor reference

- pipelinelabs `pipelinelabs~lead-scraper-apollo-zoominfo-lusha-ppe` — verified-only via `emailStatusIncludes:["deliverable"]` + `hasEmail:true`; name+domain lookup via `personFirstNameIncludes`/`personLastNameIncludes`/`companyDomainIncludes`.
- microworlds `microworlds~leads-finder` — verified-only via `email_status:["verified"]` + `contact_email_exclude_catch_all_domains:true`.
- clearpath `clearpath~email-finder-api` — `people:[{firstName,surname,domain}]`, `mode:"optimized"`; accept only `isSafeToSend && !isCatchAll`.
