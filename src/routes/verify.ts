import { Router, Response } from "express";
import { serviceAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { VerifyRequestSchema } from "../schemas.js";
import { getPlatformKey } from "../lib/keys-client.js";
import { createRun, updateRun, IdentityHeaders } from "../lib/runs-client.js";
import {
  VERIFY_EMAIL_COST,
  VERIFY_START_COST,
  provisionAndAuthorize,
  actualizeItemsAndCancel,
} from "../lib/cost-tracking.js";
import { verifyEmails } from "../lib/waterfall.js";

const router = Router();

const SERVICE_NAME = "apify-service";

function identityFromReq(req: AuthenticatedRequest): IdentityHeaders {
  return {
    orgId: req.orgId!,
    userId: req.userId,
    runId: req.runId,
    brandId: req.brandId,
    campaignId: req.campaignId,
    featureSlug: req.featureSlug,
    workflowSlug: req.workflowSlug,
    audienceId: req.audienceId,
  };
}

// ─── POST /verify ──────────────────────────────────────────────────────────────
// Verify deliverability for a batch of arbitrary email addresses. Org-scoped,
// same auth tier as /search and /resolve. One verdict per input email, from the
// 5-literal enum (valid | invalid | risky | catch_all | unknown). Cost is
// declared per the repo convention (provision → authorize → execute → actualize)
// and fails loud — a verdict is never returned without metering the spend.

router.post("/verify", serviceAuth, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = VerifyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }
  const { emails } = parsed.data;
  const identity = identityFromReq(req);

  const token = await getPlatformKey("apify", {
    callerMethod: "POST",
    callerPath: "/verify",
    audienceId: req.audienceId,
  });

  const run = await createRun({
    orgId: req.orgId!,
    userId: req.userId,
    brandId: req.brandId,
    campaignId: req.campaignId,
    featureSlug: req.featureSlug,
    workflowSlug: req.workflowSlug,
    audienceId: req.audienceId,
    parentRunId: req.runId,
    serviceName: SERVICE_NAME,
    taskName: "verify",
  });
  const runIdentity: IdentityHeaders = { ...identity, runId: run.id };

  try {
    // PROVISION worst-case + AUTHORIZE, BEFORE any Apify spend. Fail-loud if a
    // cost name isn't declarable. Worst case: one verify event per submitted
    // email + one actor-start run.
    const provisioned = await provisionAndAuthorize(
      run.id,
      [
        { costName: VERIFY_EMAIL_COST, quantity: emails.length },
        { costName: VERIFY_START_COST, quantity: 1 },
      ],
      `apify-service verify (${emails.length} emails)`,
      runIdentity
    );

    const { verdicts, verifiedCount } = await verifyEmails(token, emails);

    // ACTUALIZE real costs — per email the actor verified + the one run — and
    // cancel the worst-case holds.
    await actualizeItemsAndCancel(
      run.id,
      [
        {
          costName: VERIFY_EMAIL_COST,
          costSource: "platform",
          quantity: verifiedCount,
          status: "actual",
        },
        {
          costName: VERIFY_START_COST,
          costSource: "platform",
          quantity: 1,
          status: "actual",
        },
      ],
      provisioned,
      runIdentity
    );

    await updateRun(run.id, "completed", runIdentity);

    return res.json({ results: verdicts });
  } catch (err) {
    await updateRun(run.id, "failed", runIdentity).catch((e) =>
      console.error("[apify-service] failed to mark run failed:", e)
    );
    throw err;
  }
});

export default router;
