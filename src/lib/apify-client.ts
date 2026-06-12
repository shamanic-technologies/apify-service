/**
 * Generic Apify actor runner: start a run, poll to terminal, return the dataset
 * items + the charged-event counts. Mirrors the run+poll pattern used by
 * ahref-service. Fail-loud on any non-success run status.
 */

const APIFY_BASE_URL = "https://api.apify.com";
const START_WAIT_SECS = 60; // Apify caps waitForFinish at 60s per call.
const POLL_INTERVAL_MS = 4_000;
const MAX_WAIT_MS = 180_000;
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ApifyRunData {
  id: string;
  status: string;
  defaultDatasetId: string;
  chargedEventCounts?: Record<string, number>;
  usageTotalUsd?: number;
}

async function apifyFetch(
  url: string,
  token: string,
  init?: { method?: string; body?: unknown }
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    throw new Error(
      `[trusted-leads-service] Apify request ${url} fetch failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `[trusted-leads-service] Apify request ${url} failed (${res.status}): ${text}`
    );
  }
  return res.json();
}

export interface ApifyRunResult {
  items: Array<Record<string, unknown>>;
  chargedEventCounts: Record<string, number>;
  usageTotalUsd: number;
}

/**
 * Run an actor to completion and return its dataset items.
 *
 * `actorId` uses the tilde form (e.g. "pipelinelabs~lead-scraper-...").
 * Some Apify actors inject a non-record "banner" row into their dataset
 * (e.g. {"fullName": "🟢 Refer to the log..."}); callers filter those out via
 * the field guards in their mapper. We request clean=true to strip Apify
 * metadata fields.
 */
export async function runActor(
  token: string,
  actorId: string,
  input: Record<string, unknown>
): Promise<ApifyRunResult> {
  const startResp = (await apifyFetch(
    `${APIFY_BASE_URL}/v2/acts/${actorId}/runs?waitForFinish=${START_WAIT_SECS}`,
    token,
    { method: "POST", body: input }
  )) as { data: ApifyRunData };

  let run = startResp.data;
  const deadline = Date.now() + MAX_WAIT_MS;
  while (!TERMINAL.has(run.status)) {
    if (Date.now() > deadline) {
      throw new Error(
        `[trusted-leads-service] Apify run ${run.id} (${actorId}) did not finish within ${MAX_WAIT_MS}ms`
      );
    }
    await sleep(POLL_INTERVAL_MS);
    const polled = (await apifyFetch(
      `${APIFY_BASE_URL}/v2/acts/${actorId}/runs/${run.id}`,
      token
    )) as { data: ApifyRunData };
    run = polled.data;
  }

  if (run.status !== "SUCCEEDED") {
    throw new Error(
      `[trusted-leads-service] Apify run ${run.id} (${actorId}) ended with status ${run.status}`
    );
  }

  const raw = (await apifyFetch(
    `${APIFY_BASE_URL}/v2/datasets/${run.defaultDatasetId}/items?clean=true`,
    token
  )) as unknown;

  const items = Array.isArray(raw)
    ? (raw.filter((r) => r && typeof r === "object" && !Array.isArray(r)) as Array<
        Record<string, unknown>
      >)
    : [];

  return {
    items,
    chargedEventCounts: run.chargedEventCounts ?? {},
    usageTotalUsd: run.usageTotalUsd ?? 0,
  };
}
