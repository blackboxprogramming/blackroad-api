const express = require("express");
const rateLimitService = require("../../services/ratelimit.service");
const auditService = require("../../services/audit.service");
const send = require("../../utils/response");
const { authenticate, authorize } = require("../../middleware/auth");
const { z } = require("zod");

const router = express.Router();

// Validation schemas
const RuleSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(["user", "apikey", "ip", "endpoint"]),
  pattern: z.string().optional(),
  max_requests: z.number().min(1).max(1000000),
  window_seconds: z.number().min(1).max(86400),
  priority: z.number().min(0).max(100).optional().default(0),
});

const OverrideSchema = z.object({
  entity_id: z.string().min(1),
  entity_type: z.enum(["user", "apikey", "ip"]),
  max_requests: z.number().min(1).max(1000000),
  window_seconds: z.number().min(1).max(86400),
  reason: z.string().optional(),
  expires_at: z.string().datetime().optional(),
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

// List all rate limit rules
router.get("/rules", authenticate, authorize("admin"), (req, res) => {
  try {
    const rules = rateLimitService.findAllRules();
    send.ok(res, rules);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Create a rule
router.post("/rules", authenticate, authorize("admin"), validate(RuleSchema), (req, res) => {
  try {
    const result = rateLimitService.createRule(req.validated);

    if (result.error) {
      return send.conflict(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "create",
      resourceType: "rate_limit_rule",
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
    const result = rateLimitService.updateRule(parseInt(req.params.id), req.body);

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "update",
      resourceType: "rate_limit_rule",
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
    const result = rateLimitService.deleteRule(parseInt(req.params.id));

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "delete",
      resourceType: "rate_limit_rule",
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

// ==================== Overrides ====================

// List all overrides
router.get("/overrides", authenticate, authorize("admin"), (req, res) => {
  try {
    const { entity_type } = req.query;
    const overrides = rateLimitService.findAllOverrides({ entity_type });
    send.ok(res, overrides);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Create an override
router.post("/overrides", authenticate, authorize("admin"), validate(OverrideSchema), (req, res) => {
  try {
    const result = rateLimitService.createOverride(req.validated, req.user.id);

    auditService.log({
      userId: req.user.id,
      action: "create",
      resourceType: "rate_limit_override",
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

// Delete an override
router.delete("/overrides/:id", authenticate, authorize("admin"), (req, res) => {
  try {
    const result = rateLimitService.deleteOverride(parseInt(req.params.id));

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "delete",
      resourceType: "rate_limit_override",
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

// ==================== Usage & Stats ====================

// Get usage stats
router.get("/usage", authenticate, authorize("admin"), (req, res) => {
  try {
    const { type, limit } = req.query;
    const stats = rateLimitService.getUsageStats({
      type,
      limit: parseInt(limit) || 20,
    });
    send.ok(res, stats);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Reset rate limit for a specific key
router.post("/reset", authenticate, authorize("admin"), (req, res) => {
  try {
    const { key, type } = req.body;

    if (!key || !type) {
      return send.bad(res, "key and type are required");
    }

    const result = rateLimitService.reset(key, type);

    auditService.log({
      userId: req.user.id,
      action: "reset",
      resourceType: "rate_limit",
      resourceId: `${type}:${key}`,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Cleanup old entries
router.post("/cleanup", authenticate, authorize("admin"), (req, res) => {
  try {
    const result = rateLimitService.cleanup();
    send.ok(res, result);
  } catch (err) {
    send.serverErr(res, err);
  }
});

module.exports = router;
