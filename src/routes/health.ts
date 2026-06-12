import { Router } from "express";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "apify-service" });
});

router.get("/health/debug", (_req, res) => {
  res.json({
    status: "ok",
    service: "apify-service",
    env: {
      hasDatabaseUrl: Boolean(process.env.APIFY_SERVICE_DATABASE_URL),
      hasKeyService: Boolean(process.env.KEY_SERVICE_URL),
      hasRunsService: Boolean(process.env.RUNS_SERVICE_URL),
      hasBillingService: Boolean(process.env.BILLING_SERVICE_URL),
    },
  });
});

export default router;
