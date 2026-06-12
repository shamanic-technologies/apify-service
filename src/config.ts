/**
 * Environment config. Read lazily so unit tests can run without every var set.
 * Fail-loud: a missing required var throws when first read — never a silent fallback.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[apify-service] ${name} is not set`);
  return v;
}

export const config = {
  get databaseUrl(): string {
    return required("APIFY_SERVICE_DATABASE_URL");
  },
  get keyServiceUrl(): string {
    return required("KEY_SERVICE_URL");
  },
  get keyServiceApiKey(): string {
    return required("KEY_SERVICE_API_KEY");
  },
  get runsServiceUrl(): string {
    return required("RUNS_SERVICE_URL");
  },
  get runsServiceApiKey(): string {
    return required("RUNS_SERVICE_API_KEY");
  },
  get billingServiceUrl(): string {
    return required("BILLING_SERVICE_URL");
  },
  get billingServiceApiKey(): string {
    return required("BILLING_SERVICE_API_KEY");
  },
  get port(): number {
    return Number(process.env.PORT || 3010);
  },
};
