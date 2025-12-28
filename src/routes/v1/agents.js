const express = require("express");
const agentService = require("../../services/agent.service");
const auditService = require("../../services/audit.service");
const send = require("../../utils/response");
const { AgentSchema, AgentUpdateSchema, AgentQuerySchema, validate, validateQuery } = require("../../utils/validation");
const { authenticate, optionalAuth, authorize } = require("../../middleware/auth");
const { auditLogger } = require("../../middleware/logger");

const router = express.Router();

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

module.exports = router;
