const express = require("express");
const exportService = require("../../services/export.service");
const auditService = require("../../services/audit.service");
const send = require("../../utils/response");
const { authenticate, authorize } = require("../../middleware/auth");

const router = express.Router();

// Export agents (JSON)
router.get("/agents", authenticate, (req, res) => {
  try {
    const { role, active, format = "json" } = req.query;

    auditService.log({
      userId: req.user.id,
      action: "export",
      resourceType: "agents",
      ipAddress: req.ip,
      requestId: req.id,
    });

    if (format === "csv") {
      const csv = exportService.exportAgentsCSV({
        role,
        active: active === "true" ? true : active === "false" ? false : undefined,
      });
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=agents.csv");
      return res.send(csv);
    }

    const agents = exportService.exportAgentsJSON({
      role,
      active: active === "true" ? true : active === "false" ? false : undefined,
    });

    send.ok(res, agents);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Export audit logs (admin only)
router.get("/audit", authenticate, authorize("admin"), (req, res) => {
  try {
    const { startDate, endDate, action, resourceType, limit = "1000", format = "json" } = req.query;

    auditService.log({
      userId: req.user.id,
      action: "export",
      resourceType: "audit_log",
      ipAddress: req.ip,
      requestId: req.id,
    });

    const options = {
      startDate,
      endDate,
      action,
      resourceType,
      limit: parseInt(limit),
    };

    if (format === "csv") {
      const csv = exportService.exportAuditCSV(options);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=audit.csv");
      return res.send(csv);
    }

    const logs = exportService.exportAuditJSON(options);
    send.ok(res, logs);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Export users (admin only)
router.get("/users", authenticate, authorize("admin"), (req, res) => {
  try {
    auditService.log({
      userId: req.user.id,
      action: "export",
      resourceType: "users",
      ipAddress: req.ip,
      requestId: req.id,
    });

    const users = exportService.exportUsersJSON();
    send.ok(res, users);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Import agents (admin only)
router.post("/agents", authenticate, authorize("admin"), (req, res) => {
  try {
    const { data } = req.body;

    if (!data) {
      return send.bad(res, "Missing 'data' field with agents array");
    }

    const result = exportService.importAgentsJSON(data, req.user.id);

    if (result.error) {
      return send.bad(res, result.error);
    }

    auditService.log({
      userId: req.user.id,
      action: "import",
      resourceType: "agents",
      newValue: { created: result.created, updated: result.updated },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, result);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get export statistics
router.get("/stats", authenticate, (req, res) => {
  try {
    const stats = exportService.getExportStats();
    send.ok(res, stats);
  } catch (err) {
    send.serverErr(res, err);
  }
});

module.exports = router;
