# Project: apify-service

Verified-email lead provider backed by the Apify waterfall. **Currently pipelinelabs-only** (`ENABLED_SOURCES`); microworlds + clearpath are gated off (see Conventions — their pay-per-event pricing doesn't cleanly passthrough). Replaces Apollo for lead search + verified email. Cost tracking via runs-service (100% per-event passthrough), platform Apify key via key-service.

## Release

Prod-only repo — **no `staging` branch**. Ship via `release.sh hotfix`. Run non-interactively as `release.sh --yes hotfix <branch> "<msg>"` — the `--yes` flag MUST come **before** the subcommand (it's parsed in the global-flag loop; placed after, it's swallowed as a positional arg and the script hangs/aborts at the `read -p "Continue?"` prompt). It reuses an existing PR for `<branch>` if one is already open. It merges the PR, tags, and creates the release (all succeed), then **fails at step 4 "Sync main into staging" → exits 1** because there is no staging branch, so step 5 (delete branch) is skipped too. The exit-1 is NOT a failed ship: verify `gh pr view <N> --json state` = `MERGED` + the tag exists, then delete the feature branch manually (`git push origin --delete <branch>`). Do not re-run release.sh on this exit-1 (the tag already exists → it would fail earlier).

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
- The Apify token is a PLATFORM key. **Cost is billed PER APIFY CHARGED EVENT (100% passthrough), not per delivered lead.** Each actor is pay-per-event: a per-RUN `actor-start` fee AND per-result fees. We read each run's `chargedEventCounts` and declare every event (provision→authorize→execute→actualize, fail-loud). `COST_NAME_BY_EVENT` (cost-tracking.ts) maps each actor's Apify event name → a costs-service cost name; an unmapped event throws (never silently under-bill). Active cost names: `apify-pipelinelabs-lead` (per `lead-returned`) + `apify-pipelinelabs-actor-start` (per run). All declared names must exist in costs-service or provision 422s before spend.
- **ENABLED_SOURCES = `["pipelinelabs"]` (waterfall.ts) — pipelinelabs is the ONLY active actor.** It's the only one whose pay-per-event pricing matches our billing (start ~$0.00001/run + $0.001/lead, clean passthrough). microworlds ($0.05/run start — eaten unless batched) and clearpath (bills per pattern TESTED, hit OR miss — under-bills the per-delivered model) are DISABLED. Their code/mappers/tiers are retained but gated behind `ENABLED_SOURCES.includes(...)`. Re-enabling a source needs all three: (1) add to ENABLED_SOURCES, (2) register its `actor-start` + per-event cost names in costs-service, (3) extend the worst-case PROVISION in routes/search.ts.
- **Per-RUN `actor-start` fees mean: batch, don't run-per-lead — except on pipelinelabs.** A run-per-lead pattern pays the start fee N times. Cheap only where start ~$0 (pipelinelabs $0.00001). On microworlds ($0.05/run) run-per-lead costs ~2× Apollo. When re-enabling those actors, batch many leads per run to amortize the start.
- Verified = real DB email (tiers 1–2). Inferred = clearpath pattern-guess (tier 3, opt-in, tagged `source:"inferred"`). Never mix silently. NOTE: clearpath disabled → `/resolve` `includeInferred` is currently a no-op (kept for API stability).
- Search-parity surface (count / total / pagination) rides on **pipelinelabs only** — it exposes `countOnly` (free count, no leads extracted), `customOffset`, and rich filters (`annualRevenueIncludes`, `technologiesIncludes`, `fundingStageIncludes`, `companySizeIncludes`); microworlds has none, so it contributes only on page 1 (offset 0). `/search/count` does NO run/cost/persistence (zero billable leads = nothing to declare). `/search` adds optional `totalMatched`/`hasMore`/`nextOffset`. Pagination uses explicit `customOffset` + `dontSaveProgress:true` to avoid shared-platform-key progress bleed between orgs.

## Actor reference

Real Apify pay-per-event pricing (verified live 2026-06-14 — re-check via `GET https://api.apify.com/v2/acts/<id>` `pricingInfos`, the actor owner can change tiers with a future `startedAt`):

- pipelinelabs `pipelinelabs~lead-scraper-apollo-zoominfo-lusha-ppe` — **ACTIVE.** Events: `apify-actor-start` $0.00001/run + `lead-returned` $0.001/lead. Charged $0.002/lead + $0.00002/run (2× margin). verified-only via `emailStatusIncludes:["verified"]` + `hasEmail:true` (actor enum is `"verified"`/`"unverified"` only — `"deliverable"` 400s); name+domain lookup via `personFirstNameIncludes`/`personLastNameIncludes`/`companyDomainIncludes`.
- microworlds `microworlds~leads-finder` — **DISABLED.** Events: `apify-actor-start` **$0.05/run** (a future tier drops it to $0.001 on 2026-06-19) + `leads` ~$0.001/lead. The $0.05/run start is eaten unless batched. verified-only via `email_status:["verified"]` + `contact_email_exclude_catch_all_domains:true`.
- clearpath `clearpath~email-finder-api` — **DISABLED.** Events: `actor_start` $0.005/run + `email_pattern_tested` **$0.008 per pattern tested (hit OR miss)** — bills per attempt, not per email found, so it structurally under-bills the per-delivered-lead model. `people:[{firstName,surname,domain}]`, `mode:"optimized"`; accept only `isSafeToSend && !isCatchAll`.
