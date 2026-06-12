# Project: apify-service

Verified-email lead provider backed by the Apify waterfall (pipelinelabs + microworlds DB sources, clearpath inferred fallback). Replaces Apollo for lead search + verified email. Cost tracking via runs-service, platform Apify key via key-service.

## Release

Prod-only repo — **no `staging` branch**. Ship via `release.sh hotfix`. It merges the PR, tags, and creates the release (all succeed), then **fails at step 4 "Sync main into staging" → exits 1** because there is no staging branch, so step 5 (delete branch) is skipped too. The exit-1 is NOT a failed ship: verify `gh pr view <N> --json state` = `MERGED` + the tag exists, then delete the feature branch manually (`git push origin --delete <branch>`). Do not re-run release.sh on this exit-1 (the tag already exists → it would fail earlier).

## Commands

- `pnpm test` — Vitest
- `pnpm run build` — tsc + generate OpenAPI
- `pnpm run dev` — local dev (tsx watch)
- `pnpm run generate:openapi` — regenerate openapi.json
- `pnpm run db:generate` / `db:migrate` — Drizzle migrations

## Architecture

- `src/schemas.ts` — Zod schemas + OpenAPI registry (source of truth)
- `src/routes/search.ts` — `POST /search`, `POST /resolve`, `GET /searches/:runId`, plus the gateway-parity surface: `POST /search/count` (free match-count, no credits/persistence), `GET /search/filters-prompt` (versioned filter doc for LLMs), `GET /search/reference` (accepted-value vocab)
- `src/routes/health.ts` — health checks
- `src/lib/filter-catalog.ts` — single source of truth for accepted filter vocab + the versioned filters-prompt (`FILTERS_SCHEMA_VERSION` hashes the filter surface)
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
- Search-parity surface (count / total / pagination) rides on **pipelinelabs only** — it exposes `countOnly` (free count, no leads extracted), `customOffset`, and rich filters (`annualRevenueIncludes`, `technologiesIncludes`, `fundingStageIncludes`, `companySizeIncludes`); microworlds has none, so it contributes only on page 1 (offset 0). `/search/count` does NO run/cost/persistence (zero billable leads = nothing to declare). `/search` adds optional `totalMatched`/`hasMore`/`nextOffset`. Pagination uses explicit `customOffset` + `dontSaveProgress:true` to avoid shared-platform-key progress bleed between orgs.

## Actor reference

- pipelinelabs `pipelinelabs~lead-scraper-apollo-zoominfo-lusha-ppe` — verified-only via `emailStatusIncludes:["deliverable"]` + `hasEmail:true`; name+domain lookup via `personFirstNameIncludes`/`personLastNameIncludes`/`companyDomainIncludes`.
- microworlds `microworlds~leads-finder` — verified-only via `email_status:["verified"]` + `contact_email_exclude_catch_all_domains:true`.
- clearpath `clearpath~email-finder-api` — `people:[{firstName,surname,domain}]`, `mode:"optimized"`; accept only `isSafeToSend && !isCatchAll`.
