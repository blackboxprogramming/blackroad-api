const { getDb } = require("../db");

class CacheService {
  constructor() {
    this.memoryCache = new Map();
    this.cleanupInterval = null;
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
    };
  }

  initTable() {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS cache_entries (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        namespace TEXT DEFAULT 'default',
        ttl_seconds INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT,
        access_count INTEGER DEFAULT 0,
        last_accessed_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS cache_tags (
        cache_key TEXT REFERENCES cache_entries(key) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (cache_key, tag)
      );

      CREATE INDEX IF NOT EXISTS idx_cache_namespace ON cache_entries(namespace);
      CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries(expires_at);
      CREATE INDEX IF NOT EXISTS idx_cache_tags_tag ON cache_tags(tag);
    `);

    // Start cleanup interval
    this.startCleanup();
  }

  // Get a value from cache
  get(key, { namespace = "default", useMemory = true } = {}) {
    const fullKey = `${namespace}:${key}`;

    // Check memory cache first
    if (useMemory && this.memoryCache.has(fullKey)) {
      const memEntry = this.memoryCache.get(fullKey);
      if (!memEntry.expiresAt || new Date(memEntry.expiresAt) > new Date()) {
        this.stats.hits++;
        return memEntry.value;
      }
      this.memoryCache.delete(fullKey);
    }

    // Check database
    const db = getDb();
    const entry = db.prepare(`
      SELECT * FROM cache_entries
      WHERE key = ? AND namespace = ?
      AND (expires_at IS NULL OR expires_at > datetime('now'))
    `).get(fullKey, namespace);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Update access stats
    db.prepare(`
      UPDATE cache_entries
      SET access_count = access_count + 1, last_accessed_at = datetime('now')
      WHERE key = ?
    `).run(fullKey);

    this.stats.hits++;

    // Parse and return value
    const value = JSON.parse(entry.value);

    // Cache in memory if enabled
    if (useMemory) {
      this.memoryCache.set(fullKey, {
        value,
        expiresAt: entry.expires_at,
      });
    }

    return value;
  }

  // Set a value in cache
  set(key, value, { namespace = "default", ttl, tags = [], useMemory = true } = {}) {
    const db = getDb();
    const fullKey = `${namespace}:${key}`;
    const serializedValue = JSON.stringify(value);

    const expiresAt = ttl ? new Date(Date.now() + ttl * 1000).toISOString() : null;

    db.prepare(`
      INSERT INTO cache_entries (key, value, namespace, ttl_seconds, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        ttl_seconds = excluded.ttl_seconds,
        expires_at = excluded.expires_at,
        access_count = 0,
        last_accessed_at = datetime('now')
    `).run(fullKey, serializedValue, namespace, ttl || null, expiresAt);

    // Add tags
    if (tags.length > 0) {
      db.prepare("DELETE FROM cache_tags WHERE cache_key = ?").run(fullKey);
      const insertTag = db.prepare("INSERT INTO cache_tags (cache_key, tag) VALUES (?, ?)");
      for (const tag of tags) {
        insertTag.run(fullKey, tag);
      }
    }

    // Update memory cache
    if (useMemory) {
      this.memoryCache.set(fullKey, { value, expiresAt });
    }

    this.stats.sets++;

    return { key, namespace, ttl, expiresAt };
  }

  // Delete a value from cache
  delete(key, { namespace = "default" } = {}) {
    const db = getDb();
    const fullKey = `${namespace}:${key}`;

    const result = db.prepare("DELETE FROM cache_entries WHERE key = ?").run(fullKey);
    this.memoryCache.delete(fullKey);

    this.stats.deletes++;

    return { deleted: result.changes > 0 };
  }

  // Check if key exists
  has(key, { namespace = "default" } = {}) {
    const fullKey = `${namespace}:${key}`;

    if (this.memoryCache.has(fullKey)) {
      const memEntry = this.memoryCache.get(fullKey);
      if (!memEntry.expiresAt || new Date(memEntry.expiresAt) > new Date()) {
        return true;
      }
    }

    const db = getDb();
    const entry = db.prepare(`
      SELECT 1 FROM cache_entries
      WHERE key = ? AND namespace = ?
      AND (expires_at IS NULL OR expires_at > datetime('now'))
    `).get(fullKey, namespace);

    return Boolean(entry);
  }

  // Get or set (with factory function)
  getOrSet(key, factory, options = {}) {
    const cached = this.get(key, options);
    if (cached !== null) {
      return cached;
    }

    const value = typeof factory === "function" ? factory() : factory;
    this.set(key, value, options);
    return value;
  }

  // Delete all entries with a specific tag
  deleteByTag(tag) {
    const db = getDb();

    const keys = db.prepare(`
      SELECT cache_key FROM cache_tags WHERE tag = ?
    `).all(tag).map((row) => row.cache_key);

    if (keys.length === 0) {
      return { deleted: 0 };
    }

    const placeholders = keys.map(() => "?").join(", ");
    db.prepare(`DELETE FROM cache_entries WHERE key IN (${placeholders})`).run(...keys);

    // Clear from memory cache
    for (const key of keys) {
      this.memoryCache.delete(key);
    }

    this.stats.deletes += keys.length;

    return { deleted: keys.length, keys };
  }

  // Delete all entries in a namespace
  deleteNamespace(namespace) {
    const db = getDb();

    const result = db.prepare("DELETE FROM cache_entries WHERE namespace = ?").run(namespace);

    // Clear from memory cache
    for (const key of this.memoryCache.keys()) {
      if (key.startsWith(`${namespace}:`)) {
        this.memoryCache.delete(key);
      }
    }

    this.stats.deletes += result.changes;

    return { deleted: result.changes };
  }

  // Get all keys in a namespace
  keys({ namespace = "default", pattern } = {}) {
    const db = getDb();

    let query = "SELECT key FROM cache_entries WHERE namespace = ?";
    const params = [namespace];

    if (pattern) {
      query += " AND key LIKE ?";
      params.push(`${namespace}:${pattern.replace(/\*/g, "%")}`);
    }

    return db.prepare(query).all(...params).map((row) => row.key.replace(`${namespace}:`, ""));
  }

  // Get multiple values
  mget(keys, { namespace = "default" } = {}) {
    const result = {};
    for (const key of keys) {
      result[key] = this.get(key, { namespace });
    }
    return result;
  }

  // Set multiple values
  mset(entries, { namespace = "default", ttl } = {}) {
    const results = {};
    for (const [key, value] of Object.entries(entries)) {
      results[key] = this.set(key, value, { namespace, ttl });
    }
    return results;
  }

  // Increment a numeric value
  increment(key, { namespace = "default", by = 1 } = {}) {
    const current = this.get(key, { namespace }) || 0;
    const newValue = Number(current) + by;
    this.set(key, newValue, { namespace });
    return newValue;
  }

  // Decrement a numeric value
  decrement(key, { namespace = "default", by = 1 } = {}) {
    return this.increment(key, { namespace, by: -by });
  }

  // Clear all cache
  flush() {
    const db = getDb();
    db.prepare("DELETE FROM cache_entries").run();
    this.memoryCache.clear();
    return { flushed: true };
  }

  // Cleanup expired entries
  cleanup() {
    const db = getDb();

    const result = db.prepare(`
      DELETE FROM cache_entries
      WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')
    `).run();

    // Clean memory cache
    const now = new Date();
    for (const [key, entry] of this.memoryCache) {
      if (entry.expiresAt && new Date(entry.expiresAt) <= now) {
        this.memoryCache.delete(key);
      }
    }

    return { cleaned: result.changes };
  }

  // Get cache statistics
  getStats() {
    const db = getDb();

    const totalEntries = db.prepare("SELECT COUNT(*) as count FROM cache_entries").get().count;
    const totalSize = db.prepare("SELECT COALESCE(SUM(LENGTH(value)), 0) as size FROM cache_entries").get().size;

    const byNamespace = db.prepare(`
      SELECT namespace, COUNT(*) as count, COALESCE(SUM(LENGTH(value)), 0) as size
      FROM cache_entries
      GROUP BY namespace
    `).all().reduce((acc, row) => {
      acc[row.namespace] = { count: row.count, sizeBytes: row.size };
      return acc;
    }, {});

    const expiring = db.prepare(`
      SELECT COUNT(*) as count FROM cache_entries
      WHERE expires_at IS NOT NULL AND expires_at <= datetime('now', '+1 hour')
    `).get().count;

    return {
      totalEntries,
      totalSizeBytes: totalSize,
      totalSizeKB: Math.round(totalSize / 1024 * 100) / 100,
      memoryCacheSize: this.memoryCache.size,
      byNamespace,
      expiringSoon: expiring,
      operations: { ...this.stats },
      hitRate: this.stats.hits + this.stats.misses > 0
        ? Math.round((this.stats.hits / (this.stats.hits + this.stats.misses)) * 100 * 100) / 100
        : 0,
    };
  }

  // Get entries (for debugging/admin)
  getEntries({ namespace, page = 1, limit = 50 } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;
    const conditions = [];
    const params = [];

    if (namespace) {
      conditions.push("namespace = ?");
      params.push(namespace);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const total = db.prepare(`SELECT COUNT(*) as count FROM cache_entries ${where}`).get(...params).count;

    const entries = db.prepare(`
      SELECT key, namespace, ttl_seconds, expires_at, access_count, last_accessed_at, created_at,
             LENGTH(value) as value_size
      FROM cache_entries
      ${where}
      ORDER BY last_accessed_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return {
      data: entries.map((e) => ({
        key: e.key.includes(":") ? e.key.split(":").slice(1).join(":") : e.key,
        namespace: e.namespace,
        ttlSeconds: e.ttl_seconds,
        expiresAt: e.expires_at,
        accessCount: e.access_count,
        lastAccessedAt: e.last_accessed_at,
        createdAt: e.created_at,
        valueSize: e.value_size,
      })),
      pagination: { page, limit, total },
    };
  }

  startCleanup() {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // Every minute
  }

  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

module.exports = new CacheService();
