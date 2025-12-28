const express = require("express");
const dependencyService = require("../../services/dependency.service");
const auditService = require("../../services/audit.service");
const send = require("../../utils/response");
const { authenticate } = require("../../middleware/auth");
const { z } = require("zod");

const router = express.Router();

// Validation schema
const DependencySchema = z.object({
  agent_id: z.string().min(1),
  depends_on: z.string().min(1),
  dependency_type: z.enum(["required", "optional", "soft"]).optional().default("required"),
  description: z.string().max(500).optional(),
  health_check: z.boolean().optional().default(true),
  auto_restart: z.boolean().optional().default(false),
  start_delay_seconds: z.number().min(0).max(3600).optional().default(0),
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

// Get dependency graph
router.get("/graph", authenticate, (req, res) => {
  try {
    const graph = dependencyService.getGraph();
    send.ok(res, graph);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get start order
router.get("/start-order", authenticate, (req, res) => {
  try {
    const order = dependencyService.getStartOrder();
    send.ok(res, order);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get dependencies for an agent
router.get("/agent/:agentId", authenticate, (req, res) => {
  try {
    const dependencies = dependencyService.getDependencies(req.params.agentId);
    send.ok(res, dependencies);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get dependents of an agent
router.get("/agent/:agentId/dependents", authenticate, (req, res) => {
  try {
    const dependents = dependencyService.getDependents(req.params.agentId);
    send.ok(res, dependents);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get dependency health for an agent
router.get("/agent/:agentId/health", authenticate, (req, res) => {
  try {
    const health = dependencyService.getDependencyHealth(req.params.agentId);
    send.ok(res, health);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Add a dependency
router.post("/", authenticate, validate(DependencySchema), (req, res) => {
  try {
    const result = dependencyService.addDependency(req.validated, req.user.id);

    if (result.error) {
      if (result.error === "NOT_FOUND") {
        return send.notFound(res, result.message);
      }
      if (result.error === "CONFLICT") {
        return send.conflict(res, result.message);
      }
      if (result.error === "CIRCULAR") {
        return send.bad(res, result.message);
      }
      return send.bad(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "create",
      resourceType: "dependency",
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

// Update a dependency
router.put("/:id", authenticate, (req, res) => {
  try {
    const result = dependencyService.updateDependency(parseInt(req.params.id), req.body);

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "update",
      resourceType: "dependency",
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

// Remove a dependency
router.delete("/:agentId/:dependsOn", authenticate, (req, res) => {
  try {
    const result = dependencyService.removeDependency(req.params.agentId, req.params.dependsOn);

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "delete",
      resourceType: "dependency",
      resourceId: `${req.params.agentId}:${req.params.dependsOn}`,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get dependency events
router.get("/events", authenticate, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const { agentId, dependsOn, eventType } = req.query;

    const result = dependencyService.getEvents({ agentId, dependsOn, eventType, page, limit });
    send.paginated(res, result.data, result.pagination);
  } catch (err) {
    send.serverErr(res, err);
  }
});

module.exports = router;
