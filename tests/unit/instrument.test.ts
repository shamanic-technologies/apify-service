import { afterEach, describe, expect, it, vi } from "vitest";

const init = vi.fn();
const setTag = vi.fn();
vi.mock("@sentry/node", () => ({ init, setTag }));

describe("instrument (Sentry v11)", () => {
  const savedDsn = process.env.SENTRY_DSN;
  afterEach(() => {
    vi.resetModules();
    init.mockClear();
    setTag.mockClear();
    if (savedDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = savedDsn;
  });

  it("inits Sentry without the options v11 removed (sendDefaultPii, registerEsmLoaderHooks)", async () => {
    process.env.SENTRY_DSN = "https://key@o0.ingest.sentry.io/0";
    await import("../../src/instrument.js");
    expect(init).toHaveBeenCalledTimes(1);
    const opts = init.mock.calls[0][0];
    expect(opts.dsn).toBe("https://key@o0.ingest.sentry.io/0");
    expect(opts.tracesSampleRate).toBe(0.1);
    expect(opts).not.toHaveProperty("sendDefaultPii");
    expect(opts).not.toHaveProperty("registerEsmLoaderHooks");
    expect(setTag).toHaveBeenCalledWith("service", "apify-service");
  });

  it("does nothing without a DSN", async () => {
    delete process.env.SENTRY_DSN;
    await import("../../src/instrument.js");
    expect(init).not.toHaveBeenCalled();
  });
});
