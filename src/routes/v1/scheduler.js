const express = require("express");
const schedulerService = require("../../services/scheduler.service");
const auditService = require("../../services/audit.service");
const send = require("../../utils/response");
const { authenticate } = require("../../middleware/auth");
const { z } = require("zod");

const router = express.Router();

// Validation schema
const ScheduledCommandSchema = z.object({
  name: z.string().min(1).max(100),
  agentId: z.string().optional(),
  groupId: z.number().optional(),
  command: z.enum(["start", "stop", "restart", "ping", "configure", "update", "status"]),
  payload: z.record(z.unknown()).optional().default({}),
  scheduleType: z.enum(["once", "interval", "cron"]),
  cronExpression: z.string().optional(),
  runAt: z.string().datetime().optional(),
  repeatInterval: z.number().min(60).optional(), // Minimum 60 seconds
  maxRuns: z.number().min(1).optional(),
}).refine(
  (data) => data.agentId || data.groupId,
  { message: "Either agentId or groupId is required" }
);

const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return send.bad(res, "Validation failed", {
      errors: result.error.errors.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    });
  }
  req.validated = result.data;
  next();
};

// List all scheduled commands
router.get("/", authenticate, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const enabled = req.query.enabled === "true" ? true :
                   req.query.enabled === "false" ? false : undefined;

    const result = schedulerService.findAll({ page, limit, enabled });
    send.paginated(res, result.data, result.pagination);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get scheduled command by ID
router.get("/:id", authenticate, (req, res) => {
  try {
    const scheduled = schedulerService.findById(parseInt(req.params.id));
    if (!scheduled) {
      return send.notFound(res, "Scheduled command not found");
    }
    send.ok(res, scheduled);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Create scheduled command
router.post("/", authenticate, validate(ScheduledCommandSchema), (req, res) => {
  try {
    const result = schedulerService.create(req.validated, req.user.id);

    if (result.error) {
      return send.bad(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "create",
      resourceType: "scheduled_command",
      resourceId: result.data.id.toString(),
      newValue: result.data,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Update scheduled command
router.put("/:id", authenticate, (req, res) => {
  try {
    const result = schedulerService.update(parseInt(req.params.id), req.body);

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "update",
      resourceType: "scheduled_command",
      resourceId: req.params.id,
      oldValue: result.oldValue,
      newValue: result.data,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Delete scheduled command
router.delete("/:id", authenticate, (req, res) => {
  try {
    const result = schedulerService.delete(parseInt(req.params.id));

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "delete",
      resourceType: "scheduled_command",
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

// Enable/disable scheduled command
router.patch("/:id/enabled", authenticate, (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return send.bad(res, "enabled must be a boolean");
    }

    const result = schedulerService.setEnabled(parseInt(req.params.id), enabled);

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: enabled ? "enable" : "disable",
      resourceType: "scheduled_command",
      resourceId: req.params.id,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get run history
router.get("/:id/runs", authenticate, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    const result = schedulerService.getRunHistory(parseInt(req.params.id), { page, limit });
    send.paginated(res, result.data, result.pagination);
  } catch (err) {
    send.serverErr(res, err);
  }
});

module.exports = router;
