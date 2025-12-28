const express = require("express");
const groupService = require("../../services/group.service");
const auditService = require("../../services/audit.service");
const send = require("../../utils/response");
const { authenticate, authorize } = require("../../middleware/auth");
const { z } = require("zod");

const router = express.Router();

// Validation schemas
const GroupSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const TagSchema = z.object({
  name: z.string().min(1).max(50),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
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

// ==================== Groups ====================

// List all groups
router.get("/", authenticate, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    const result = groupService.findAllGroups({ page, limit });
    send.paginated(res, result.data, result.pagination);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get group by ID
router.get("/:id", authenticate, (req, res) => {
  try {
    const group = groupService.findGroupById(parseInt(req.params.id));
    if (!group) {
      return send.notFound(res, "Group not found");
    }
    send.ok(res, group);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Create group
router.post("/", authenticate, validate(GroupSchema), (req, res) => {
  try {
    const result = groupService.createGroup(req.validated, req.user.id);

    if (result.error === "CONFLICT") {
      return send.conflict(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "create",
      resourceType: "group",
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

// Update group
router.put("/:id", authenticate, validate(GroupSchema.partial()), (req, res) => {
  try {
    const result = groupService.updateGroup(parseInt(req.params.id), req.validated, req.user.id);

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    if (result.error === "CONFLICT") {
      return send.conflict(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "update",
      resourceType: "group",
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

// Delete group
router.delete("/:id", authenticate, authorize("admin"), (req, res) => {
  try {
    const result = groupService.deleteGroup(parseInt(req.params.id));

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "delete",
      resourceType: "group",
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

// Get group members
router.get("/:id/members", authenticate, (req, res) => {
  try {
    const group = groupService.findGroupById(parseInt(req.params.id));
    if (!group) {
      return send.notFound(res, "Group not found");
    }

    const members = groupService.getGroupMembers(parseInt(req.params.id));
    send.ok(res, members);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Add agent to group
router.post("/:id/members/:agentId", authenticate, (req, res) => {
  try {
    const result = groupService.addAgentToGroup(
      parseInt(req.params.id),
      req.params.agentId,
      req.user.id
    );

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    if (result.error === "CONFLICT") {
      return send.conflict(res, result.message);
    }

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Remove agent from group
router.delete("/:id/members/:agentId", authenticate, (req, res) => {
  try {
    const result = groupService.removeAgentFromGroup(
      parseInt(req.params.id),
      req.params.agentId
    );

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// ==================== Tags ====================

// List all tags
router.get("/tags/all", authenticate, (req, res) => {
  try {
    const tags = groupService.findAllTags();
    send.ok(res, tags);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Create tag
router.post("/tags", authenticate, validate(TagSchema), (req, res) => {
  try {
    const result = groupService.createTag(req.validated.name, req.validated.color);

    if (result.error === "CONFLICT") {
      return send.conflict(res, result.message);
    }

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Delete tag
router.delete("/tags/:id", authenticate, authorize("admin"), (req, res) => {
  try {
    const result = groupService.deleteTag(parseInt(req.params.id));

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get agents by tag
router.get("/tags/:id/agents", authenticate, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    const result = groupService.getAgentsByTag(parseInt(req.params.id), { page, limit });
    send.paginated(res, result.data, result.pagination);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Assign tag to agent
router.post("/tags/:tagId/agents/:agentId", authenticate, (req, res) => {
  try {
    const result = groupService.assignTagToAgent(
      parseInt(req.params.tagId),
      req.params.agentId
    );

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    if (result.error === "CONFLICT") {
      return send.conflict(res, result.message);
    }

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Remove tag from agent
router.delete("/tags/:tagId/agents/:agentId", authenticate, (req, res) => {
  try {
    const result = groupService.removeTagFromAgent(
      parseInt(req.params.tagId),
      req.params.agentId
    );

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

module.exports = router;
