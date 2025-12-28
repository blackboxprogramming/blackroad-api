const { getDb } = require("../db");

class RateLimitService {
  constructor() {
    this.cache = new Map(); // In-memory cache for fast lookups
    this.cleanupInterval = null;
  }

  initTable() {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL, -- 'user', 'apikey', 'ip', 'global'
        max_requests INTEGER DEFAULT 1000,
        window_seconds INTEGER DEFAULT 3600,
        current_count INTEGER DEFAULT 0,
        window_start TEXT DEFAULT (datetime('now')),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS rate_limit_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL, -- 'user', 'apikey', 'ip', 'endpoint'
        pattern TEXT, -- regex for endpoint matching
        max_requests INTEGER NOT NULL,
        window_seconds INTEGER NOT NULL,
        enabled INTEGER DEFAULT 1,
        priority INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS rate_limit_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id TEXT NOT NULL, -- user_id, apikey_id, or IP
        entity_type TEXT NOT NULL,
        max_requests INTEGER NOT NULL,
        window_seconds INTEGER NOT NULL,
        reason TEXT,
        expires_at TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_rate_limits_key ON rate_limits(key);
      CREATE INDEX IF NOT EXISTS idx_rate_limit_rules_type ON rate_limit_rules(type, enabled);
      CREATE INDEX IF NOT EXISTS idx_rate_limit_overrides_entity ON rate_limit_overrides(entity_id, entity_type);
    `);

    // Seed default rules
    this._seedDefaultRules();
  }

  _seedDefaultRules() {
    const db = getDb();
    const existing = db.prepare("SELECT COUNT(*) as count FROM rate_limit_rules").get();

    if (existing.count === 0) {
      const defaultRules = [
        { name: "default_user", type: "user", max_requests: 1000, window_seconds: 3600, priority: 0 },
        { name: "default_apikey", type: "apikey", max_requests: 5000, window_seconds: 3600, priority: 0 },
        { name: "default_ip", type: "ip", max_requests: 100, window_seconds: 60, priority: 0 },
        { name: "auth_endpoint", type: "endpoint", pattern: "^/api/v1/auth", max_requests: 20, window_seconds: 60, priority: 10 },
        { name: "export_endpoint", type: "endpoint", pattern: "^/api/v1/export", max_requests: 10, window_seconds: 300, priority: 10 },
      ];

      const stmt = db.prepare(`
        INSERT INTO rate_limit_rules (name, type, pattern, max_requests, window_seconds, priority)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const rule of defaultRules) {
        stmt.run(rule.name, rule.type, rule.pattern || null, rule.max_requests, rule.window_seconds, rule.priority);
      }
    }
  }

  // Check if request should be rate limited
  check(key, type = "user") {
    const db = getDb();
    const now = new Date();

    // Check for override first
    const override = this._getOverride(key, type);
    const rule = override || this._getRule(type);

    if (!rule) {
      return { allowed: true, remaining: Infinity };
    }

    const cacheKey = `${type}:${key}`;
    let entry = this.cache.get(cacheKey);

    if (!entry) {
      // Check database
      entry = db.prepare("SELECT * FROM rate_limits WHERE key = ?").get(cacheKey);

      if (!entry) {
        // Create new entry
        db.prepare(`
          INSERT INTO rate_limits (key, type, max_requests, window_seconds, current_count, window_start)
          VALUES (?, ?, ?, ?, 1, datetime('now'))
        `).run(cacheKey, type, rule.max_requests, rule.window_seconds);

        this.cache.set(cacheKey, {
          count: 1,
          windowStart: now,
          maxRequests: rule.max_requests,
          windowSeconds: rule.window_seconds,
        });

        return {
          allowed: true,
          remaining: rule.max_requests - 1,
          resetAt: new Date(now.getTime() + rule.window_seconds * 1000).toISOString(),
        };
      }

      entry = {
        count: entry.current_count,
        windowStart: new Date(entry.window_start),
        maxRequests: entry.max_requests,
        windowSeconds: entry.window_seconds,
      };
      this.cache.set(cacheKey, entry);
    }

    // Check if window has expired
    const windowEnd = new Date(entry.windowStart.getTime() + entry.windowSeconds * 1000);

    if (now >= windowEnd) {
      // Reset window
      entry.count = 1;
      entry.windowStart = now;
      this.cache.set(cacheKey, entry);

      db.prepare(`
        UPDATE rate_limits
        SET current_count = 1, window_start = datetime('now'), updated_at = datetime('now')
        WHERE key = ?
      `).run(cacheKey);

      return {
        allowed: true,
        remaining: entry.maxRequests - 1,
        resetAt: new Date(now.getTime() + entry.windowSeconds * 1000).toISOString(),
      };
    }

    // Check if limit exceeded
    if (entry.count >= entry.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: windowEnd.toISOString(),
        retryAfter: Math.ceil((windowEnd.getTime() - now.getTime()) / 1000),
      };
    }

    // Increment counter
    entry.count++;
    this.cache.set(cacheKey, entry);

    db.prepare(`
      UPDATE rate_limits
      SET current_count = current_count + 1, updated_at = datetime('now')
      WHERE key = ?
    `).run(cacheKey);

    return {
      allowed: true,
      remaining: entry.maxRequests - entry.count,
      resetAt: windowEnd.toISOString(),
    };
  }

  _getRule(type) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM rate_limit_rules
      WHERE type = ? AND enabled = 1
      ORDER BY priority DESC
      LIMIT 1
    `).get(type);
  }

  _getOverride(entityId, entityType) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM rate_limit_overrides
      WHERE entity_id = ? AND entity_type = ?
      AND (expires_at IS NULL OR expires_at > datetime('now'))
    `).get(entityId, entityType);
  }

  // Create or update a rule
  createRule(data) {
    const db = getDb();
    const { name, type, pattern, max_requests, window_seconds, priority = 0 } = data;

    try {
      const result = db.prepare(`
        INSERT INTO rate_limit_rules (name, type, pattern, max_requests, window_seconds, priority)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(name, type, pattern || null, max_requests, window_seconds, priority);

      return { data: { id: result.lastInsertRowid, ...data } };
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { error: "CONFLICT", message: "Rule name already exists" };
      }
      throw err;
    }
  }

  // Get all rules
  findAllRules() {
    const db = getDb();
    return db.prepare("SELECT * FROM rate_limit_rules ORDER BY priority DESC, name").all();
  }

  // Update a rule
  updateRule(id, data) {
    const db = getDb();
    const existing = db.prepare("SELECT * FROM rate_limit_rules WHERE id = ?").get(id);

    if (!existing) {
      return { error: "NOT_FOUND", message: "Rule not found" };
    }

    const updates = [];
    const params = [];

    if (data.max_requests !== undefined) {
      updates.push("max_requests = ?");
      params.push(data.max_requests);
    }
    if (data.window_seconds !== undefined) {
      updates.push("window_seconds = ?");
      params.push(data.window_seconds);
    }
    if (data.enabled !== undefined) {
      updates.push("enabled = ?");
      params.push(data.enabled ? 1 : 0);
    }
    if (data.priority !== undefined) {
      updates.push("priority = ?");
      params.push(data.priority);
    }
    if (data.pattern !== undefined) {
      updates.push("pattern = ?");
      params.push(data.pattern);
    }

    if (updates.length === 0) {
      return { data: existing };
    }

    params.push(id);
    db.prepare(`UPDATE rate_limit_rules SET ${updates.join(", ")} WHERE id = ?`).run(...params);

    return { data: db.prepare("SELECT * FROM rate_limit_rules WHERE id = ?").get(id), oldValue: existing };
  }

  // Delete a rule
  deleteRule(id) {
    const db = getDb();
    const existing = db.prepare("SELECT * FROM rate_limit_rules WHERE id = ?").get(id);

    if (!existing) {
      return { error: "NOT_FOUND", message: "Rule not found" };
    }

    db.prepare("DELETE FROM rate_limit_rules WHERE id = ?").run(id);
    return { data: existing };
  }

  // Create an override for a specific entity
  createOverride(data, userId) {
    const db = getDb();
    const { entity_id, entity_type, max_requests, window_seconds, reason, expires_at } = data;

    const result = db.prepare(`
      INSERT INTO rate_limit_overrides (entity_id, entity_type, max_requests, window_seconds, reason, expires_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(entity_id, entity_type, max_requests, window_seconds, reason || null, expires_at || null, userId);

    // Clear cache for this entity
    this.cache.delete(`${entity_type}:${entity_id}`);

    return { data: { id: result.lastInsertRowid, ...data } };
  }

  // Get overrides
  findAllOverrides({ entity_type } = {}) {
    const db = getDb();
    let query = "SELECT o.*, u.username as created_by_username FROM rate_limit_overrides o LEFT JOIN users u ON o.created_by = u.id";
    const params = [];

    if (entity_type) {
      query += " WHERE o.entity_type = ?";
      params.push(entity_type);
    }

    query += " ORDER BY o.created_at DESC";
    return db.prepare(query).all(...params);
  }

  // Delete an override
  deleteOverride(id) {
    const db = getDb();
    const existing = db.prepare("SELECT * FROM rate_limit_overrides WHERE id = ?").get(id);

    if (!existing) {
      return { error: "NOT_FOUND", message: "Override not found" };
    }

    // Clear cache
    this.cache.delete(`${existing.entity_type}:${existing.entity_id}`);

    db.prepare("DELETE FROM rate_limit_overrides WHERE id = ?").run(id);
    return { data: existing };
  }

  // Get usage stats
  getUsageStats({ type, limit = 20 } = {}) {
    const db = getDb();
    let query = `
      SELECT key, type, max_requests, current_count, window_start,
        ROUND(CAST(current_count AS FLOAT) / max_requests * 100, 2) as usage_percent
      FROM rate_limits
    `;
    const params = [];

    if (type) {
      query += " WHERE type = ?";
      params.push(type);
    }

    query += " ORDER BY usage_percent DESC LIMIT ?";
    params.push(limit);

    return db.prepare(query).all(...params);
  }

  // Reset rate limit for a key
  reset(key, type) {
    const cacheKey = `${type}:${key}`;
    this.cache.delete(cacheKey);

    const db = getDb();
    db.prepare("DELETE FROM rate_limits WHERE key = ?").run(cacheKey);

    return { data: { key, type, reset: true } };
  }

  // Cleanup expired entries
  cleanup() {
    const db = getDb();

    // Remove old rate limit entries (older than 24 hours)
    const result = db.prepare(`
      DELETE FROM rate_limits
      WHERE updated_at < datetime('now', '-1 day')
    `).run();

    // Clear cache
    this.cache.clear();

    return { cleaned: result.changes };
  }

  startCleanup() {
    this.cleanupInterval = setInterval(() => this.cleanup(), 3600000); // Every hour
  }

  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

module.exports = new RateLimitService();
