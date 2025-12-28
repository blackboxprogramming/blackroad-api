const crypto = require("crypto");
const { getDb } = require("../db");
const { logger } = require("../middleware/logger");

class SessionService {
  constructor() {
    this.cleanupInterval = null;
  }

  // Initialize session tables
  initTable() {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        device_info TEXT DEFAULT '{}',
        last_activity_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        revoked INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON user_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON user_sessions(token_hash);
    `);
  }

  // Start cleanup job
  startCleanup() {
    if (this.cleanupInterval) return;

    // Clean up expired sessions every hour
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, 3600000);
  }

  // Stop cleanup job
  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  // Create a new session
  create(userId, token, { ipAddress, userAgent, expiresIn = 86400 } = {}) {
    const db = getDb();
    const sessionId = crypto.randomUUID();
    const tokenHash = this._hashToken(token);
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    const deviceInfo = this._parseUserAgent(userAgent);

    db.prepare(`
      INSERT INTO user_sessions (id, user_id, token_hash, ip_address, user_agent, device_info, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, userId, tokenHash, ipAddress, userAgent, JSON.stringify(deviceInfo), expiresAt);

    logger.info({ sessionId, userId, ipAddress }, "Session created");

    return {
      id: sessionId,
      expiresAt,
    };
  }

  // Validate session by token
  validateToken(token) {
    const db = getDb();
    const tokenHash = this._hashToken(token);
    const now = new Date().toISOString();

    const session = db.prepare(`
      SELECT s.*, u.username, u.role
      FROM user_sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token_hash = ? AND s.revoked = 0 AND s.expires_at > ?
    `).get(tokenHash, now);

    if (!session) {
      return null;
    }

    // Update last activity
    db.prepare("UPDATE user_sessions SET last_activity_at = datetime('now') WHERE id = ?")
      .run(session.id);

    return {
      sessionId: session.id,
      userId: session.user_id,
      username: session.username,
      role: session.role,
      ipAddress: session.ip_address,
      createdAt: session.created_at,
      expiresAt: session.expires_at,
    };
  }

  // Get all sessions for a user
  getUserSessions(userId) {
    const db = getDb();
    const now = new Date().toISOString();

    const sessions = db.prepare(`
      SELECT * FROM user_sessions
      WHERE user_id = ? AND revoked = 0 AND expires_at > ?
      ORDER BY last_activity_at DESC
    `).all(userId, now);

    return sessions.map(this._format);
  }

  // Get session by ID
  findById(sessionId) {
    const db = getDb();
    const session = db.prepare("SELECT * FROM user_sessions WHERE id = ?").get(sessionId);
    return session ? this._format(session) : null;
  }

  // Revoke a session
  revoke(sessionId, userId = null) {
    const db = getDb();

    let query = "UPDATE user_sessions SET revoked = 1 WHERE id = ?";
    const params = [sessionId];

    // If userId provided, ensure session belongs to user
    if (userId) {
      query += " AND user_id = ?";
      params.push(userId);
    }

    const result = db.prepare(query).run(...params);

    if (result.changes === 0) {
      return { error: "NOT_FOUND", message: "Session not found" };
    }

    logger.info({ sessionId }, "Session revoked");
    return { data: { sessionId, revoked: true } };
  }

  // Revoke all sessions for a user
  revokeAllUserSessions(userId, exceptSessionId = null) {
    const db = getDb();

    let query = "UPDATE user_sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0";
    const params = [userId];

    if (exceptSessionId) {
      query += " AND id != ?";
      params.push(exceptSessionId);
    }

    const result = db.prepare(query).run(...params);

    logger.info({ userId, count: result.changes }, "All user sessions revoked");
    return { data: { userId, revokedCount: result.changes } };
  }

  // Cleanup expired sessions
  cleanupExpired() {
    const db = getDb();
    const now = new Date().toISOString();

    const result = db.prepare("DELETE FROM user_sessions WHERE expires_at < ? OR revoked = 1")
      .run(now);

    if (result.changes > 0) {
      logger.info({ count: result.changes }, "Expired sessions cleaned up");
    }

    return { deletedCount: result.changes };
  }

  // Get session statistics
  getStats() {
    const db = getDb();
    const now = new Date().toISOString();

    const totalActive = db.prepare(`
      SELECT COUNT(*) as count FROM user_sessions
      WHERE revoked = 0 AND expires_at > ?
    `).get(now).count;

    const byUser = db.prepare(`
      SELECT u.username, COUNT(*) as session_count
      FROM user_sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.revoked = 0 AND s.expires_at > ?
      GROUP BY s.user_id
      ORDER BY session_count DESC
      LIMIT 10
    `).all(now);

    const recentActivity = db.prepare(`
      SELECT COUNT(*) as count FROM user_sessions
      WHERE last_activity_at > datetime('now', '-1 hour')
    `).get().count;

    return {
      totalActive,
      activeLastHour: recentActivity,
      topUsers: byUser,
    };
  }

  // Extend session expiration
  extend(sessionId, additionalSeconds = 3600) {
    const db = getDb();

    const session = this.findById(sessionId);
    if (!session || session.revoked) {
      return { error: "NOT_FOUND", message: "Session not found" };
    }

    const newExpiry = new Date(Date.now() + additionalSeconds * 1000).toISOString();

    db.prepare("UPDATE user_sessions SET expires_at = ? WHERE id = ?")
      .run(newExpiry, sessionId);

    return { data: { sessionId, expiresAt: newExpiry } };
  }

  _hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  _parseUserAgent(userAgent) {
    if (!userAgent) return {};

    const info = {
      browser: "Unknown",
      os: "Unknown",
      device: "Unknown",
    };

    // Simple parsing
    if (userAgent.includes("Chrome")) info.browser = "Chrome";
    else if (userAgent.includes("Firefox")) info.browser = "Firefox";
    else if (userAgent.includes("Safari")) info.browser = "Safari";
    else if (userAgent.includes("Edge")) info.browser = "Edge";

    if (userAgent.includes("Windows")) info.os = "Windows";
    else if (userAgent.includes("Mac")) info.os = "macOS";
    else if (userAgent.includes("Linux")) info.os = "Linux";
    else if (userAgent.includes("Android")) info.os = "Android";
    else if (userAgent.includes("iOS") || userAgent.includes("iPhone")) info.os = "iOS";

    if (userAgent.includes("Mobile")) info.device = "Mobile";
    else if (userAgent.includes("Tablet")) info.device = "Tablet";
    else info.device = "Desktop";

    return info;
  }

  _format(session) {
    return {
      id: session.id,
      userId: session.user_id,
      ipAddress: session.ip_address,
      userAgent: session.user_agent,
      deviceInfo: JSON.parse(session.device_info || "{}"),
      lastActivityAt: session.last_activity_at,
      expiresAt: session.expires_at,
      revoked: Boolean(session.revoked),
      createdAt: session.created_at,
    };
  }
}

module.exports = new SessionService();
