const express = require("express");
const cacheService = require("../../services/cache.service");
const send = require("../../utils/response");
const { authenticate, authorize } = require("../../middleware/auth");

const router = express.Router();

// Get a cache entry
router.get("/entries/:key", authenticate, (req, res) => {
  try {
    const { namespace = "default" } = req.query;
    const value = cacheService.get(req.params.key, { namespace });

    if (value === null) {
      return send.notFound(res, "Cache entry not found");
    }

    send.ok(res, { key: req.params.key, namespace, value });
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Set a cache entry
router.post("/entries/:key", authenticate, (req, res) => {
  try {
    const { value, namespace = "default", ttl, tags = [] } = req.body;

    if (value === undefined) {
      return send.bad(res, "value is required");
    }

    const result = cacheService.set(req.params.key, value, { namespace, ttl, tags });
    send.ok(res, result);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Delete a cache entry
router.delete("/entries/:key", authenticate, (req, res) => {
  try {
    const { namespace = "default" } = req.query;
    const result = cacheService.delete(req.params.key, { namespace });
    send.ok(res, result);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Check if key exists
router.head("/entries/:key", authenticate, (req, res) => {
  try {
    const { namespace = "default" } = req.query;
    const exists = cacheService.has(req.params.key, { namespace });
    res.status(exists ? 200 : 404).end();
  } catch {
    res.status(500).end();
  }
});

// Get multiple entries
router.post("/mget", authenticate, (req, res) => {
  try {
    const { keys, namespace = "default" } = req.body;

    if (!keys || !Array.isArray(keys)) {
      return send.bad(res, "keys array is required");
    }

    const result = cacheService.mget(keys, { namespace });
    send.ok(res, result);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Set multiple entries
router.post("/mset", authenticate, (req, res) => {
  try {
    const { entries, namespace = "default", ttl } = req.body;

    if (!entries || typeof entries !== "object") {
      return send.bad(res, "entries object is required");
    }

    const result = cacheService.mset(entries, { namespace, ttl });
    send.ok(res, result);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Increment a value
router.post("/entries/:key/increment", authenticate, (req, res) => {
  try {
    const { namespace = "default", by = 1 } = req.body;
    const newValue = cacheService.increment(req.params.key, { namespace, by });
    send.ok(res, { key: req.params.key, value: newValue });
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Decrement a value
router.post("/entries/:key/decrement", authenticate, (req, res) => {
  try {
    const { namespace = "default", by = 1 } = req.body;
    const newValue = cacheService.decrement(req.params.key, { namespace, by });
    send.ok(res, { key: req.params.key, value: newValue });
  } catch (err) {
    send.serverErr(res, err);
  }
});

// List keys in namespace
router.get("/keys", authenticate, (req, res) => {
  try {
    const { namespace = "default", pattern } = req.query;
    const keys = cacheService.keys({ namespace, pattern });
    send.ok(res, keys);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Delete by tag
router.delete("/tags/:tag", authenticate, authorize("admin"), (req, res) => {
  try {
    const result = cacheService.deleteByTag(req.params.tag);
    send.ok(res, result);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Delete namespace
router.delete("/namespaces/:namespace", authenticate, authorize("admin"), (req, res) => {
  try {
    const result = cacheService.deleteNamespace(req.params.namespace);
    send.ok(res, result);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Flush all cache
router.post("/flush", authenticate, authorize("admin"), (req, res) => {
  try {
    const result = cacheService.flush();
    send.ok(res, result);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Cleanup expired entries
router.post("/cleanup", authenticate, authorize("admin"), (req, res) => {
  try {
    const result = cacheService.cleanup();
    send.ok(res, result);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get cache stats
router.get("/stats", authenticate, (req, res) => {
  try {
    const stats = cacheService.getStats();
    send.ok(res, stats);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// List all entries (admin)
router.get("/entries", authenticate, authorize("admin"), (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const { namespace } = req.query;

    const result = cacheService.getEntries({ namespace, page, limit });
    send.paginated(res, result.data, result.pagination);
  } catch (err) {
    send.serverErr(res, err);
  }
});

module.exports = router;
