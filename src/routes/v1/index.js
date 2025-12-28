const express = require("express");
const agentsRouter = require("./agents");
const authRouter = require("./auth");
const auditRouter = require("./audit");
const webhooksRouter = require("./webhooks");
const exportRouter = require("./export");
const groupsRouter = require("./groups");
const schedulerRouter = require("./scheduler");
const dashboardRouter = require("./dashboard");
const sessionsRouter = require("./sessions");
const notificationsRouter = require("./notifications");
const permissionsRouter = require("./permissions");

// v2.3 routes
const rateLimitsRouter = require("./ratelimits");
const bulkRouter = require("./bulk");
const templatesRouter = require("./templates");
const searchRouter = require("./search");
const healthRouter = require("./health");

// v2.4 routes
const workflowsRouter = require("./workflows");
const alertsRouter = require("./alerts");
const backupsRouter = require("./backups");
const cacheRouter = require("./cache");
const dependenciesRouter = require("./dependencies");

const router = express.Router();

// Mount v1 routes
router.use("/agents", agentsRouter);
router.use("/auth", authRouter);
router.use("/audit", auditRouter);
router.use("/webhooks", webhooksRouter);
router.use("/export", exportRouter);
router.use("/groups", groupsRouter);
router.use("/scheduler", schedulerRouter);
router.use("/dashboard", dashboardRouter);
router.use("/sessions", sessionsRouter);
router.use("/notifications", notificationsRouter);
router.use("/permissions", permissionsRouter);

// v2.3 routes
router.use("/ratelimits", rateLimitsRouter);
router.use("/bulk", bulkRouter);
router.use("/templates", templatesRouter);
router.use("/search", searchRouter);
router.use("/health", healthRouter);

// v2.4 routes
router.use("/workflows", workflowsRouter);
router.use("/alerts", alertsRouter);
router.use("/backups", backupsRouter);
router.use("/cache", cacheRouter);
router.use("/dependencies", dependenciesRouter);

// Echo endpoint (useful for testing)
router.post("/echo", (req, res) => {
  res.status(200).json({
    ok: true,
    status: 200,
    data: {
      you_sent: req.body || null,
      headers: {
        contentType: req.headers["content-type"],
        userAgent: req.headers["user-agent"],
      },
      requestId: req.id,
    },
  });
});

module.exports = router;
