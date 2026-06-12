import { config } from "../config.js";

const TIMEOUT_MS = 30_000;

export interface CallerContext {
  callerMethod: string;
  callerPath: string;
}

/**
 * Resolve a decrypted PLATFORM key for a provider via key-service.
 * The Apify token is a platform key (we pay the Apify bill), so we use the
 * platform decrypt endpoint. Fail-loud on any non-2xx.
 */
export async function getPlatformKey(
  provider: string,
  caller: CallerContext
): Promise<string> {
  const url = `${config.keyServiceUrl}/keys/platform/${provider}/decrypt`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "X-API-Key": config.keyServiceApiKey,
        "X-Caller-Service": "trusted-leads",
        "X-Caller-Method": caller.callerMethod,
        "X-Caller-Path": caller.callerPath,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `[trusted-leads-service] key-service platform decrypt fetch failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `[trusted-leads-service] key-service platform decrypt for "${provider}" failed (${res.status}): ${text}`
    );
  }
  const data = (await res.json()) as { key: string };
  if (!data.key) {
    throw new Error(
      `[trusted-leads-service] key-service returned no key for "${provider}"`
    );
  }
  return data.key;
}
