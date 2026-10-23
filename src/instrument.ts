import * as Sentry from "@sentry/node";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0.1,
    // Sentry v11: `sendDefaultPii: true` is now the `dataCollection` default (option removed), and
    // `registerEsmLoaderHooks` is gone (instrumentation is channel-based, no ESM loader hook to exclude drizzle from).
  });
  Sentry.setTag("service", "apify-service");
}
