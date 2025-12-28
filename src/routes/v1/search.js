const express = require("express");
const searchService = require("../../services/search.service");
const send = require("../../utils/response");
const { authenticate } = require("../../middleware/auth");

const router = express.Router();

// Unified search
router.get("/", authenticate, (req, res) => {
  try {
    const { q, types, limit } = req.query;

    if (!q || q.length < 2) {
      return send.bad(res, "Query must be at least 2 characters");
    }

    const typeList = types ? types.split(",") : undefined;

    const results = searchService.search(q, {
      types: typeList,
      limit: parseInt(limit) || 20,
      userId: req.user.id,
    });

    send.ok(res, results);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get search suggestions (for autocomplete)
router.get("/suggest", authenticate, (req, res) => {
  try {
    const { q, type } = req.query;

    const suggestions = searchService.getSuggestions(q, type);
    send.ok(res, suggestions);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Advanced agent search
router.get("/agents", authenticate, (req, res) => {
  try {
    const {
      q,
      role,
      active,
      groupId,
      tagId,
      hasHeartbeat,
      createdAfter,
      createdBefore,
      page,
      limit,
      sortBy,
      sortOrder,
    } = req.query;

    const results = searchService.searchAgents({
      query: q,
      role,
      active: active === "true" ? true : active === "false" ? false : undefined,
      groupId: groupId ? parseInt(groupId) : undefined,
      tagId: tagId ? parseInt(tagId) : undefined,
      hasHeartbeat: hasHeartbeat === "true" ? true : hasHeartbeat === "false" ? false : undefined,
      createdAfter,
      createdBefore,
      page: parseInt(page) || 1,
      limit: Math.min(parseInt(limit) || 50, 100),
      sortBy,
      sortOrder,
    });

    send.paginated(res, results.data, results.pagination, { filters: results.filters });
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Search audit logs
router.get("/audit", authenticate, (req, res) => {
  try {
    const {
      q,
      userId,
      action,
      resourceType,
      resourceId,
      startDate,
      endDate,
      page,
      limit,
    } = req.query;

    const results = searchService.searchAuditLogs({
      query: q,
      userId: userId ? parseInt(userId) : undefined,
      action,
      resourceType,
      resourceId,
      startDate,
      endDate,
      page: parseInt(page) || 1,
      limit: Math.min(parseInt(limit) || 50, 100),
    });

    send.paginated(res, results.data, results.pagination);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Quick search by entity type
router.get("/:type", authenticate, (req, res) => {
  try {
    const { type } = req.params;
    const { q, limit } = req.query;

    const validTypes = ["agents", "groups", "tags", "commands", "users", "templates", "webhooks"];

    if (!validTypes.includes(type)) {
      return send.bad(res, `Invalid type. Must be one of: ${validTypes.join(", ")}`);
    }

    if (!q || q.length < 2) {
      return send.bad(res, "Query must be at least 2 characters");
    }

    const results = searchService.search(q, {
      types: [type],
      limit: parseInt(limit) || 20,
      userId: req.user.id,
    });

    send.ok(res, results);
  } catch (err) {
    send.serverErr(res, err);
  }
});

module.exports = router;
