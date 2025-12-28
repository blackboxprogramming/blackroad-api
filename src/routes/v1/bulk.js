const express = require("express");
const bulkService = require("../../services/bulk.service");
const auditService = require("../../services/audit.service");
const send = require("../../utils/response");
const { authenticate } = require("../../middleware/auth");
const { z } = require("zod");

const router = express.Router();

// Validation schema
const BulkOperationSchema = z.object({
  type: z.enum(["command", "update", "delete", "tag", "group"]),
  target_type: z.enum(["agents", "groups", "tags"]),
  target_ids: z.array(z.union([z.string(), z.number()])).min(1).max(1000),
  operation_data: z.record(z.unknown()).optional().default({}),
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

// List all bulk operations
router.get("/", authenticate, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const { status, type } = req.query;

    const result = bulkService.findAll({
      page,
      limit,
      status,
      type,
      userId: req.query.mine === "true" ? req.user.id : undefined,
    });

    send.paginated(res, result.data, result.pagination);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get bulk operation by ID
router.get("/:id", authenticate, (req, res) => {
  try {
    const operation = bulkService.findById(parseInt(req.params.id));

    if (!operation) {
      return send.notFound(res, "Bulk operation not found");
    }

    send.ok(res, operation);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Create a bulk operation
router.post("/", authenticate, validate(BulkOperationSchema), (req, res) => {
  try {
    // Add userId to operation data for audit trail
    req.validated.operation_data.userId = req.user.id;

    const result = bulkService.create(req.validated, req.user.id);

    auditService.log({
      userId: req.user.id,
      action: "create",
      resourceType: "bulk_operation",
      resourceId: result.data.id.toString(),
      newValue: {
        type: req.validated.type,
        targetCount: req.validated.target_ids.length,
      },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Process a pending bulk operation
router.post("/:id/process", authenticate, (req, res) => {
  try {
    const result = bulkService.process(parseInt(req.params.id));

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

// Cancel a pending bulk operation
router.post("/:id/cancel", authenticate, (req, res) => {
  try {
    const result = bulkService.cancel(parseInt(req.params.id));

    if (result.error) {
      if (result.error === "NOT_FOUND") {
        return send.notFound(res, result.message);
      }
      return send.bad(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "cancel",
      resourceType: "bulk_operation",
      resourceId: req.params.id,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Retry failed items in a bulk operation
router.post("/:id/retry", authenticate, (req, res) => {
  try {
    const result = bulkService.retry(parseInt(req.params.id), req.user.id);

    if (result.error) {
      if (result.error === "NOT_FOUND") {
        return send.notFound(res, result.message);
      }
      return send.bad(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "retry",
      resourceType: "bulk_operation",
      resourceId: req.params.id,
      newValue: { newOperationId: result.data.id },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// ==================== Convenience Endpoints ====================

// Bulk send command to agents
router.post("/command", authenticate, (req, res) => {
  try {
    const { agent_ids, command, payload = {} } = req.body;

    if (!agent_ids || !Array.isArray(agent_ids) || agent_ids.length === 0) {
      return send.bad(res, "agent_ids array is required");
    }

    if (!command) {
      return send.bad(res, "command is required");
    }

    const result = bulkService.create({
      type: "command",
      target_type: "agents",
      target_ids: agent_ids,
      operation_data: { command, payload, userId: req.user.id },
    }, req.user.id);

    auditService.log({
      userId: req.user.id,
      action: "bulk_command",
      resourceType: "agents",
      newValue: { command, agentCount: agent_ids.length },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Bulk update agents
router.post("/update", authenticate, (req, res) => {
  try {
    const { agent_ids, updates } = req.body;

    if (!agent_ids || !Array.isArray(agent_ids) || agent_ids.length === 0) {
      return send.bad(res, "agent_ids array is required");
    }

    if (!updates || typeof updates !== "object") {
      return send.bad(res, "updates object is required");
    }

    const result = bulkService.create({
      type: "update",
      target_type: "agents",
      target_ids: agent_ids,
      operation_data: { updates },
    }, req.user.id);

    auditService.log({
      userId: req.user.id,
      action: "bulk_update",
      resourceType: "agents",
      newValue: { updates, agentCount: agent_ids.length },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Bulk add agents to group
router.post("/group/add", authenticate, (req, res) => {
  try {
    const { agent_ids, group_id } = req.body;

    if (!agent_ids || !Array.isArray(agent_ids) || agent_ids.length === 0) {
      return send.bad(res, "agent_ids array is required");
    }

    if (!group_id) {
      return send.bad(res, "group_id is required");
    }

    const result = bulkService.create({
      type: "group",
      target_type: "agents",
      target_ids: agent_ids,
      operation_data: { action: "add", groupId: group_id, userId: req.user.id },
    }, req.user.id);

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Bulk remove agents from group
router.post("/group/remove", authenticate, (req, res) => {
  try {
    const { agent_ids, group_id } = req.body;

    if (!agent_ids || !Array.isArray(agent_ids) || agent_ids.length === 0) {
      return send.bad(res, "agent_ids array is required");
    }

    if (!group_id) {
      return send.bad(res, "group_id is required");
    }

    const result = bulkService.create({
      type: "group",
      target_type: "agents",
      target_ids: agent_ids,
      operation_data: { action: "remove", groupId: group_id },
    }, req.user.id);

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Bulk add tag to agents
router.post("/tag/add", authenticate, (req, res) => {
  try {
    const { agent_ids, tag_id } = req.body;

    if (!agent_ids || !Array.isArray(agent_ids) || agent_ids.length === 0) {
      return send.bad(res, "agent_ids array is required");
    }

    if (!tag_id) {
      return send.bad(res, "tag_id is required");
    }

    const result = bulkService.create({
      type: "tag",
      target_type: "agents",
      target_ids: agent_ids,
      operation_data: { action: "add", tagId: tag_id },
    }, req.user.id);

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Bulk remove tag from agents
router.post("/tag/remove", authenticate, (req, res) => {
  try {
    const { agent_ids, tag_id } = req.body;

    if (!agent_ids || !Array.isArray(agent_ids) || agent_ids.length === 0) {
      return send.bad(res, "agent_ids array is required");
    }

    if (!tag_id) {
      return send.bad(res, "tag_id is required");
    }

    const result = bulkService.create({
      type: "tag",
      target_type: "agents",
      target_ids: agent_ids,
      operation_data: { action: "remove", tagId: tag_id },
    }, req.user.id);

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

module.exports = router;
