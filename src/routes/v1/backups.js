const express = require("express");
const backupService = require("../../services/backup.service");
const auditService = require("../../services/audit.service");
const send = require("../../utils/response");
const { authenticate, authorize } = require("../../middleware/auth");

const router = express.Router();

// List all backups
router.get("/", authenticate, authorize("admin"), (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const { type, status } = req.query;

    const result = backupService.findAll({ page, limit, type, status });
    send.paginated(res, result.data, result.pagination);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get backup by ID
router.get("/:id", authenticate, authorize("admin"), (req, res) => {
  try {
    const backup = backupService.findById(parseInt(req.params.id));
    if (!backup) {
      return send.notFound(res, "Backup not found");
    }
    send.ok(res, backup);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Create a backup
router.post("/", authenticate, authorize("admin"), (req, res) => {
  try {
    const { name, type = "full", tables } = req.body;

    const result = backupService.create({ name, type, tables }, req.user.id);

    if (result.error) {
      return send.serverErr(res, { message: result.message });
    }

    auditService.log({
      userId: req.user.id,
      action: "create",
      resourceType: "backup",
      resourceId: result.data.id.toString(),
      newValue: { name: result.data.name, type: result.data.type, sizeMB: result.data.sizeMB },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Restore from backup
router.post("/:id/restore", authenticate, authorize("admin"), (req, res) => {
  try {
    const { tables, dryRun = false } = req.body;

    const result = backupService.restore(parseInt(req.params.id), { tables, dryRun });

    if (result.error) {
      if (result.error === "NOT_FOUND" || result.error === "FILE_NOT_FOUND") {
        return send.notFound(res, result.message);
      }
      if (result.error === "CHECKSUM_MISMATCH") {
        return send.bad(res, result.message);
      }
      return send.serverErr(res, { message: result.message });
    }

    if (!dryRun) {
      auditService.log({
        userId: req.user.id,
        action: "restore",
        resourceType: "backup",
        resourceId: req.params.id,
        newValue: result.data,
        ipAddress: req.ip,
        requestId: req.id,
      });
    }

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Delete a backup
router.delete("/:id", authenticate, authorize("admin"), (req, res) => {
  try {
    const result = backupService.delete(parseInt(req.params.id));

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "delete",
      resourceType: "backup",
      resourceId: req.params.id,
      oldValue: result.data,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, { deleted: true });
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Download a backup
router.get("/:id/download", authenticate, authorize("admin"), (req, res) => {
  try {
    const result = backupService.getDownloadPath(parseInt(req.params.id));

    if (result.error) {
      if (result.error === "NOT_FOUND" || result.error === "FILE_NOT_FOUND") {
        return send.notFound(res, result.message);
      }
      return send.serverErr(res, { message: result.message });
    }

    res.download(result.data.path, result.data.filename);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Export to JSON
router.post("/export/json", authenticate, authorize("admin"), (req, res) => {
  try {
    const { tables, pretty = false } = req.body;

    const result = backupService.exportToJson(tables, { pretty });

    // Return as downloadable JSON
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="export-${Date.now()}.json"`);
    res.send(result.data.json);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Import from JSON
router.post("/import/json", authenticate, authorize("admin"), (req, res) => {
  try {
    const { data, tables, mode = "merge" } = req.body;

    if (!data) {
      return send.bad(res, "data is required");
    }

    const result = backupService.importFromJson(data, { tables, mode });

    if (result.error) {
      return send.bad(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "import",
      resourceType: "backup",
      newValue: result.data,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Cleanup old backups
router.post("/cleanup", authenticate, authorize("admin"), (req, res) => {
  try {
    const { retention_days = 30 } = req.body;

    const result = backupService.cleanup(retention_days);

    auditService.log({
      userId: req.user.id,
      action: "cleanup",
      resourceType: "backup",
      newValue: result.data,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get backup stats
router.get("/stats/summary", authenticate, authorize("admin"), (req, res) => {
  try {
    const stats = backupService.getStats();
    send.ok(res, stats);
  } catch (err) {
    send.serverErr(res, err);
  }
});

module.exports = router;
