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
- `src/lib/saturation.ts` — pure per-campaign no-repeat + saturation-stop helpers (`emissionKey`, `selectFreshLeads`, `computePaging`) used by `/search` (#18)
- `src/db/schema.ts` — `lead_searches` + `leads` (leads doubles as 12-month cache) + `lead_emissions` (per-campaign no-repeat log)

## Conventions

- TypeScript strict, ESM (NodeNext), pnpm, Express 4 + `express-async-errors`, Zod 4 + zod-to-openapi v8, Drizzle (postgres-js), Vitest.
- Fail-loud: no swallowed errors, no silent fallbacks, no `.default()` on Zod.
- Log prefix `[apify-service]`.
- Migrations auto-run at boot; SQL is idempotent (`IF NOT EXISTS`).
- **`/search` ALWAYS calls the paid actor and bills per actor-RETURNED lead.** The `leads` unique index (`leads_cache_idx`) dedups STORAGE only — never billing. So re-paging a saturated campaign re-bills the actor every page (prod 1dba3969…: 42 pages, 4 200 leads billed, 71 distinct, 20 min). Spend is bounded by the saturation-stop (#18), NOT by the cache. `/resolve` (not `/search`) is the path that checks the 12-month cache before spending.
- **`/search` terminality is FRESH-distinct-driven, NOT arithmetic — do NOT revert to `hasMore = totalMatched > offset+limit` (#18).** The pipelinelabs cursor does NOT short-page at exhaustion: it recycles full pages of already-served leads at the tail (`lead_count == limit` at every offset 200→4100), so `totalMatched` (the inflated count probe) can never signal a drained pool. Per-campaign no-repeat: every lead handed back is logged in `lead_emissions` keyed `(org, campaign, person)`; `/search` excludes already-emitted people for the campaign; `hasMore = freshCount > 0 && consumed < totalMatched` (a page with zero FRESH distinct ⟹ truthful `done`, bounded=1). `totalMatched` stays the dry-run/count surface unchanged. `brand_ids[]` on `lead_emissions` is reserved for the future per-brand 6-month window (human-service#36); per-brand/cross-provider dedup is OUT of scope here.
- The Apify token is a PLATFORM key. **Cost has TWO billable events per actor: a per-RUN `actor-start` fee AND a per-lead fee — declare BOTH** (provision→authorize→execute→actualize, fail-loud). Active cost names: `apify-pipelinelabs-lead` + `apify-pipelinelabs-actor-start`. All must exist in costs-service or provision 422s before spend.
- **Bill from what we OBSERVE, NOT from `chargedEventCounts` — that field is unreliable.** Apify returns `chargedEventCounts: null` for the pipelinelabs actor even on runs it charged per-lead (verified 2026-06-14: a run with `usageTotalUsd: 0.10001` = start + 100 leads still reports `null`). Reading it under-bills silently (v0.0.3 regression: every lead went unbilled, only `actor-start` — which settles early — got through). So: **lead cost = count of DELIVERED leads per source (`actualItemsBySource`); actor-start cost = count of RUNS we executed per source (`startItemsBySource`, `RunsBySource` from waterfall).** Both reliable, no `chargedEventCounts` dependency. Do NOT reintroduce per-`chargedEventCounts` billing.
- **ENABLED_SOURCES = `["pipelinelabs"]` (waterfall.ts) — pipelinelabs is the ONLY active actor.** It's the only one whose pay-per-event pricing matches our billing (start ~$0.00001/run + $0.001/lead, clean passthrough). microworlds ($0.05/run start — eaten unless batched) and clearpath (bills per pattern TESTED, hit OR miss — under-bills the per-delivered model) are DISABLED. Their code/mappers/tiers are retained but gated behind `ENABLED_SOURCES.includes(...)`. Re-enabling a source needs all three: (1) add to ENABLED_SOURCES, (2) register its `actor-start` + per-event cost names in costs-service, (3) extend the worst-case PROVISION in routes/search.ts.
- **Per-RUN `actor-start` fees mean: batch, don't run-per-lead — except on pipelinelabs.** A run-per-lead pattern pays the start fee N times. Cheap only where start ~$0 (pipelinelabs $0.00001). On microworlds ($0.05/run) run-per-lead costs ~2× Apollo. When re-enabling those actors, batch many leads per run to amortize the start.
- Verified = real DB email (tiers 1–2). Inferred = clearpath pattern-guess (tier 3, opt-in, tagged `source:"inferred"`). Never mix silently. NOTE: clearpath disabled → `/resolve` `includeInferred` is currently a no-op (kept for API stability).
- Search-parity surface (count / total / pagination) rides on **pipelinelabs only** — it exposes `countOnly` (free count, no leads extracted), `customOffset`, and rich filters (`annualRevenueIncludes`, `technologiesIncludes`, `fundingStageIncludes`, `companySizeIncludes`); microworlds has none, so it contributes only on page 1 (offset 0). `/search/count` does NO run/cost/persistence (zero billable leads = nothing to declare). `/search` adds optional `totalMatched`/`hasMore`/`nextOffset`. Pagination uses explicit `customOffset` + `dontSaveProgress:true` to avoid shared-platform-key progress bleed between orgs.

## Data layering (Bronze / Silver / Gold)

The `/search` no-repeat + saturation-stop (#18) is a medallion split — validated against Beauchemin's *Functional Data Engineering* (immutable facts, idempotent pure tasks, isolate cumulative state), Airbyte's incremental *Append + Deduped* (dedup on a stable primary key when the source has no usable cursor), and Databricks/Kleppmann (raw = truth, aggregates are projections):

- **Bronze (raw, billed):** what the pipelinelabs actor RETURNED per page — `pageLeads`. The actor charges per returned lead, so bronze is the **billing source of truth** (`actualizeAndCancel(run, pageLeads, …)`). Captured by the existing surfaces (`leads.responseRaw` + runs-service cost rows + `lead_searches` audit) — **no dedicated bronze table** (single source; don't build state nobody reads).
- **Silver (canonical, deduped, delivered):** `lead_emissions` — one row per `(org, campaign, person)`, idempotent append + natural-key dedup (`lead_emissions_key_idx`, `onConflictDoNothing`). The per-campaign no-repeat ledger. `leads` (+ `leads_cache_idx`) is the org-scoped canonical person cache. `/search` **delivers the silver subset** (`freshLeads`), never bronze.
- **Gold (projection):** terminality (`hasMore`/`done`) is DERIVED, never stored — `computePaging()` over the fresh-distinct count. `done` = "this page added zero net-new to silver". Since pipelinelabs exposes no cursor (offset recycles), this is the Airbyte "no usable cursor ⟹ dedup on primary key, converged when the delta is empty" pattern, not arithmetic on `totalMatched`.

**Doctrine: bill bronze, deliver silver.** Per-campaign filtering changes what we HAND BACK (silver), never what the actor charged (bronze) — that's why the No-go "don't change billing" holds while spend still drops (saturation-stop cuts FURTHER pages). Pure terminality logic lives in `src/lib/saturation.ts` (testable without DB/Apify); the route wires the silver reads/writes around it.

**Deferred (separate issue, NOT #18):** serve a campaign from silver (`lead_emissions`/`leads`) before hitting the paid actor at all — the bigger spend lever. Out of #18's scope; needs its own discussion.

## Actor reference

Real Apify pay-per-event pricing (verified live 2026-06-14 — re-check via `GET https://api.apify.com/v2/acts/<id>` `pricingInfos`, the actor owner can change tiers with a future `startedAt`):

- pipelinelabs `pipelinelabs~lead-scraper-apollo-zoominfo-lusha-ppe` — **ACTIVE.** Events: `apify-actor-start` $0.00001/run + `lead-returned` $0.001/lead. Charged $0.002/lead + $0.00002/run (2× margin). verified-only via `emailStatusIncludes:["verified"]` + `hasEmail:true` (actor enum is `"verified"`/`"unverified"` only — `"deliverable"` 400s); name+domain lookup via `personFirstNameIncludes`/`personLastNameIncludes`/`companyDomainIncludes`.
- microworlds `microworlds~leads-finder` — **DISABLED.** Events: `apify-actor-start` **$0.05/run** (a future tier drops it to $0.001 on 2026-06-19) + `leads` ~$0.001/lead. The $0.05/run start is eaten unless batched. verified-only via `email_status:["verified"]` + `contact_email_exclude_catch_all_domains:true`.
- clearpath `clearpath~email-finder-api` — **DISABLED.** Events: `actor_start` $0.005/run + `email_pattern_tested` **$0.008 per pattern tested (hit OR miss)** — bills per attempt, not per email found, so it structurally under-bills the per-delivered-lead model. `people:[{firstName,surname,domain}]`, `mode:"optimized"`; accept only `isSafeToSend && !isCatchAll`.
