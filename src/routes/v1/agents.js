const express = require("express");
const agentService = require("../../services/agent.service");
const auditService = require("../../services/audit.service");
const agentControlService = require("../../services/agent-control.service");
const send = require("../../utils/response");
const { AgentSchema, AgentUpdateSchema, AgentQuerySchema, validate, validateQuery } = require("../../utils/validation");
const { authenticate, optionalAuth, authorize } = require("../../middleware/auth");
const { auditLogger } = require("../../middleware/logger");
const { z } = require("zod");

const router = express.Router();

// Command validation schema
const CommandSchema = z.object({
  command: z.enum(["start", "stop", "restart", "ping", "configure", "update", "status"]),
  payload: z.record(z.unknown()).optional().default({}),
  expiresIn: z.number().min(10).max(86400).optional().default(300),
});

// Heartbeat validation schema
const HeartbeatSchema = z.object({
  status: z.enum(["healthy", "unhealthy", "starting", "stopping", "running", "idle"]).default("healthy"),
  metrics: z.record(z.unknown()).optional().default({}),
  version: z.string().optional(),
});

const validateBody = (schema) => (req, res, next) => {
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

// List all agents with pagination/filtering (public read, auth for metadata)
router.get("/", optionalAuth, validateQuery(AgentQuerySchema), (req, res) => {
  try {
    const result = agentService.findAll(req.query);
    send.paginated(res, result.data, result.pagination);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get single agent by ID
router.get("/:id", optionalAuth, (req, res) => {
  try {
    const agent = agentService.findById(req.params.id);
    if (!agent) {
      return send.notFound(res, "Agent not found", { id: req.params.id });
    }
    send.ok(res, agent);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Create new agent (authenticated)
router.post(
  "/",
  authenticate,
  validate(AgentSchema),
  auditLogger("create", "agent"),
  (req, res) => {
    try {
      const result = agentService.create(req.validated, req.user?.id);

      if (result.error === "CONFLICT") {
        return send.conflict(res, result.message, { id: req.validated.id });
      }

      // Log audit
      auditService.log({
        userId: req.user?.id,
        action: "create",
        resourceType: "agent",
        resourceId: result.data.id,
        newValue: result.data,
        ipAddress: req.ip,
        requestId: req.id,
      });

      send.created(res, result.data);
    } catch (err) {
      send.serverErr(res, err);
    }
  }
);

// Update agent (authenticated)
router.put(
  "/:id",
  authenticate,
  validate(AgentUpdateSchema),
  auditLogger("update", "agent"),
  (req, res) => {
    try {
      const result = agentService.update(req.params.id, req.validated, req.user?.id);

      if (result.error === "NOT_FOUND") {
        return send.notFound(res, result.message, { id: req.params.id });
      }

      // Log audit
      auditService.log({
        userId: req.user?.id,
        action: "update",
        resourceType: "agent",
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
  }
);

// Partial update (PATCH)
router.patch(
  "/:id",
  authenticate,
  validate(AgentUpdateSchema),
  auditLogger("update", "agent"),
  (req, res) => {
    try {
      const result = agentService.update(req.params.id, req.validated, req.user?.id);

      if (result.error === "NOT_FOUND") {
        return send.notFound(res, result.message, { id: req.params.id });
      }

      auditService.log({
        userId: req.user?.id,
        action: "update",
        resourceType: "agent",
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
  }
);

// Delete agent (admin only)
router.delete(
  "/:id",
  authenticate,
  authorize("admin"),
  auditLogger("delete", "agent"),
  (req, res) => {
    try {
      const result = agentService.delete(req.params.id);

      if (result.error === "NOT_FOUND") {
        return send.notFound(res, result.message, { id: req.params.id });
      }

      auditService.log({
        userId: req.user?.id,
        action: "delete",
        resourceType: "agent",
        resourceId: req.params.id,
        oldValue: result.data,
        ipAddress: req.ip,
        requestId: req.id,
      });

      send.ok(res, { deleted: result.data.id });
    } catch (err) {
      send.serverErr(res, err);
    }
  }
);

// ==================== Agent Control Commands ====================

// Get agent health status
router.get("/:id/health", optionalAuth, (req, res) => {
  try {
    const result = agentControlService.getAgentHealth(req.params.id);

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    send.ok(res, result);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Issue command to agent
router.post("/:id/commands", authenticate, validateBody(CommandSchema), (req, res) => {
  try {
    const { command, payload, expiresIn } = req.validated;
    const result = agentControlService.issueCommand(
      req.params.id,
      command,
      payload,
      req.user.id,
      expiresIn
    );

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    if (result.error === "INVALID_COMMAND") {
      return send.bad(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "command",
      resourceType: "agent",
      resourceId: req.params.id,
      newValue: { command, payload },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get pending commands for agent (used by agents polling for commands)
router.get("/:id/commands/pending", authenticate, (req, res) => {
  try {
    const commands = agentControlService.getPendingCommands(req.params.id);
    send.ok(res, commands);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Acknowledge command execution
router.post("/:id/commands/:commandId/ack", authenticate, (req, res) => {
  try {
    const { result, success = true } = req.body;
    const ackResult = agentControlService.acknowledgeCommand(
      parseInt(req.params.commandId),
      result,
      success
    );

    if (ackResult.error === "NOT_FOUND") {
      return send.notFound(res, ackResult.message);
    }

    send.ok(res, ackResult.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get command history
router.get("/:id/commands", authenticate, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    const result = agentControlService.getCommandHistory(req.params.id, { page, limit });
    send.paginated(res, result.data, result.pagination);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// ==================== Agent Heartbeat ====================

// Record heartbeat from agent
router.post("/:id/heartbeat", authenticate, validateBody(HeartbeatSchema), (req, res) => {
  try {
    const result = agentControlService.recordHeartbeat(req.params.id, {
      ...req.validated,
      ipAddress: req.ip,
    });

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    // Return pending commands in response
    const pendingCommands = agentControlService.getPendingCommands(req.params.id);

    send.ok(res, {
      recorded: true,
      pendingCommands,
    });
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get heartbeat history
router.get("/:id/heartbeats", authenticate, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const hours = Math.min(parseInt(req.query.hours) || 24, 168);

    const result = agentControlService.getHeartbeatHistory(req.params.id, { page, limit, hours });
    send.paginated(res, result.data, result.pagination);
  } catch (err) {
    send.serverErr(res, err);
  }
});

module.exports = router;
