const express = require("express");
const alertService = require("../../services/alert.service");
const auditService = require("../../services/audit.service");
const send = require("../../utils/response");
const { authenticate, authorize } = require("../../middleware/auth");
const { z } = require("zod");

const router = express.Router();

// Validation schema
const AlertRuleSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  condition_type: z.enum(["threshold", "absence", "pattern", "comparison"]),
  metric: z.string().min(1),
  operator: z.enum([">", "<", ">=", "<=", "==", "!="]).optional(),
  threshold: z.number().optional(),
  duration_seconds: z.number().min(1).max(86400).optional().default(60),
  severity: z.enum(["info", "warning", "error", "critical"]).optional().default("warning"),
  notify_channels: z.array(z.string()).optional().default(["websocket"]),
  cooldown_seconds: z.number().min(0).max(86400).optional().default(300),
  config: z.record(z.unknown()).optional().default({}),
});

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

// ==================== Rules ====================

// List all rules
router.get("/rules", authenticate, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const enabled = req.query.enabled === "true" ? true : req.query.enabled === "false" ? false : undefined;
    const { severity } = req.query;

    const result = alertService.findAllRules({ page, limit, enabled, severity });
    send.paginated(res, result.data, result.pagination);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get rule by ID
router.get("/rules/:id", authenticate, (req, res) => {
  try {
    const rule = alertService.findRuleById(parseInt(req.params.id));
    if (!rule) {
      return send.notFound(res, "Alert rule not found");
    }
    send.ok(res, rule);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Create a rule
router.post("/rules", authenticate, authorize("admin"), validate(AlertRuleSchema), (req, res) => {
  try {
    const result = alertService.createRule(req.validated, req.user.id);

    if (result.error === "CONFLICT") {
      return send.conflict(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "create",
      resourceType: "alert_rule",
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

// Update a rule
router.put("/rules/:id", authenticate, authorize("admin"), (req, res) => {
  try {
    const result = alertService.updateRule(parseInt(req.params.id), req.body);

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }
    if (result.error === "CONFLICT") {
      return send.conflict(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "update",
      resourceType: "alert_rule",
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

// Delete a rule
router.delete("/rules/:id", authenticate, authorize("admin"), (req, res) => {
  try {
    const result = alertService.deleteRule(parseInt(req.params.id));

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "delete",
      resourceType: "alert_rule",
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

// ==================== Events ====================

// Get all events
router.get("/events", authenticate, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const { status, severity, rule_id } = req.query;

    const result = alertService.getEvents({
      page,
      limit,
      status,
      severity,
      rule_id: rule_id ? parseInt(rule_id) : undefined,
    });
    send.paginated(res, result.data, result.pagination);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get event by ID
router.get("/events/:id", authenticate, (req, res) => {
  try {
    const event = alertService.getEvent(parseInt(req.params.id));
    if (!event) {
      return send.notFound(res, "Alert event not found");
    }
    send.ok(res, event);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Create manual alert
router.post("/events", authenticate, (req, res) => {
  try {
    const { rule_id, severity, message, context } = req.body;

    const result = alertService.createEvent({ rule_id, severity, message, context });
    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Acknowledge an alert
router.post("/events/:id/acknowledge", authenticate, (req, res) => {
  try {
    const result = alertService.acknowledge(parseInt(req.params.id), req.user.id);

    if (result.error) {
      if (result.error === "NOT_FOUND") {
        return send.notFound(res, result.message);
      }
      return send.bad(res, result.message);
    }

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Resolve an alert
router.post("/events/:id/resolve", authenticate, (req, res) => {
  try {
    const result = alertService.resolve(parseInt(req.params.id), req.user.id);

    if (result.error) {
      if (result.error === "NOT_FOUND") {
        return send.notFound(res, result.message);
      }
      return send.bad(res, result.message);
    }

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// ==================== Subscriptions ====================

// Get user's subscriptions
router.get("/subscriptions", authenticate, (req, res) => {
  try {
    const subscriptions = alertService.getUserSubscriptions(req.user.id);
    send.ok(res, subscriptions);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Subscribe to a rule
router.post("/subscriptions", authenticate, (req, res) => {
  try {
    const { rule_id, channel = "websocket", config = {} } = req.body;

    if (!rule_id) {
      return send.bad(res, "rule_id is required");
    }

    const result = alertService.subscribe(req.user.id, rule_id, channel, config);

    if (result.error === "CONFLICT") {
      return send.conflict(res, result.message);
    }

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Unsubscribe from a rule
router.delete("/subscriptions/:ruleId/:channel", authenticate, (req, res) => {
  try {
    const result = alertService.unsubscribe(
      req.user.id,
      parseInt(req.params.ruleId),
      req.params.channel
    );

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// ==================== Summary ====================

// Get alert summary
router.get("/summary", authenticate, (req, res) => {
  try {
    const summary = alertService.getSummary();
    send.ok(res, summary);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Trigger an alert (for testing or programmatic use)
router.post("/trigger/:ruleId", authenticate, (req, res) => {
  try {
    const { value, message, context } = req.body;

    const result = alertService.trigger(parseInt(req.params.ruleId), { value, message, context });

    if (result.error) {
      if (result.error === "INVALID") {
        return send.bad(res, result.message);
      }
      if (result.error === "COOLDOWN") {
        return send.bad(res, result.message);
      }
    }

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

module.exports = router;
