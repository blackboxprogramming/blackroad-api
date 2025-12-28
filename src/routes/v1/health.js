const express = require("express");
const healthService = require("../../services/health.service");
const send = require("../../utils/response");
const { authenticate, authorize } = require("../../middleware/auth");

const router = express.Router();

// Liveness probe (no auth required - for k8s/docker)
router.get("/live", (_req, res) => {
  const result = healthService.liveness();
  res.status(200).json(result);
});

// Readiness probe (no auth required - for k8s/docker)
router.get("/ready", async (_req, res) => {
  const result = await healthService.readiness();
  const status = result.status === "ready" ? 200 : 503;
  res.status(status).json(result);
});

// Full health check (requires auth)
router.get("/", authenticate, async (req, res) => {
  try {
    const results = await healthService.runChecks();
    const status = results.status === "healthy" ? 200 : results.status === "degraded" ? 200 : 503;
    res.status(status).json({
      ok: true,
      status: results.status === "healthy" ? 200 : results.status === "degraded" ? 200 : 503,
      data: results,
    });
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get last health check results (cached)
router.get("/cached", authenticate, (_req, res) => {
  try {
    const results = healthService.getLastResults();

    if (!results) {
      return send.ok(res, { message: "No health check results available yet" });
    }

    send.ok(res, results);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get system information (admin only)
router.get("/system", authenticate, authorize("admin"), (_req, res) => {
  try {
    const info = healthService.getSystemInfo();
    send.ok(res, info);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get database statistics (admin only)
router.get("/database", authenticate, authorize("admin"), (_req, res) => {
  try {
    const stats = healthService.getDatabaseStats();
    send.ok(res, stats);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Trigger a health check manually
router.post("/check", authenticate, authorize("admin"), async (_req, res) => {
  try {
    const results = await healthService.runChecks();
    send.ok(res, results);
  } catch (err) {
    send.serverErr(res, err);
  }
});

module.exports = router;
