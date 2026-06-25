import { config } from "../config.js";
import type { IdentityHeaders } from "./runs-client.js";

const TIMEOUT_MS = 60_000;

/**
 * Org-scoped synchronous LLM completion via chat-service `POST /complete`.
 *
 * chat-service owns the model resolution, the provider key, AND the LLM cost
 * declaration (the spend is metered against the caller's org there), so this
 * client declares NO cost locally — it just forwards the prompt + identity. We
 * never import a provider SDK here (CLAUDE.md: "LLM spend routes through
 * chat-service — never a direct provider SDK in a consumer service").
 *
 * Fail-loud: any non-2xx, fetch failure, or missing `json` (when a
 * responseSchema/json format was requested) throws.
 */
export interface CompleteParams {
  message: string;
  systemPrompt: string;
  provider: "anthropic" | "google";
  model: "haiku" | "sonnet" | "opus" | "flash-lite" | "flash" | "flash-pro" | "pro";
  temperature?: number;
  maxTokens?: number;
  disableThinking?: boolean;
  /** JSON Schema for provider-enforced structured output. Implies json format. */
  responseSchema?: Record<string, unknown>;
}

export interface CompleteResult {
  content: string;
  json?: Record<string, unknown>;
  tokensInput: number;
  tokensOutput: number;
  model: string;
}

export async function complete(
  params: CompleteParams,
  identity: IdentityHeaders
): Promise<CompleteResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": config.chatServiceApiKey,
    "x-org-id": identity.orgId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.brandId) headers["x-brand-id"] = identity.brandId;
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.featureSlug) headers["x-feature-slug"] = identity.featureSlug;
  if (identity.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;
  if (identity.audienceId) headers["x-audience-id"] = identity.audienceId;

  const body: Record<string, unknown> = {
    message: params.message,
    systemPrompt: params.systemPrompt,
    provider: params.provider,
    model: params.model,
  };
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.maxTokens !== undefined) body.maxTokens = params.maxTokens;
  if (params.disableThinking !== undefined) body.disableThinking = params.disableThinking;
  if (params.responseSchema !== undefined) {
    body.responseFormat = "json";
    body.responseSchema = params.responseSchema;
  }

  let res: Response;
  try {
    res = await fetch(`${config.chatServiceUrl}/complete`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `[apify-service] chat-service /complete fetch failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `[apify-service] chat-service /complete failed (${res.status}): ${text}`
    );
  }
  const data = (await res.json()) as CompleteResult;
  if (params.responseSchema !== undefined && !data.json) {
    throw new Error(
      "[apify-service] chat-service /complete returned no parsed `json` for a structured-output request"
    );
  }
  return data;
}
