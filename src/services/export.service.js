const { getDb } = require("../db");

class ExportService {
  // Export agents to JSON
  exportAgentsJSON({ role, active, includeMetadata = true } = {}) {
    const db = getDb();

    let query = "SELECT * FROM agents WHERE 1=1";
    const params = [];

    if (role) {
      query += " AND role = ?";
      params.push(role);
    }

    if (active !== undefined) {
      query += " AND active = ?";
      params.push(active ? 1 : 0);
    }

    query += " ORDER BY id";

    const agents = db.prepare(query).all(...params);

    return agents.map((a) => ({
      id: a.id,
      role: a.role,
      active: Boolean(a.active),
      ...(includeMetadata ? { metadata: JSON.parse(a.metadata || "{}") } : {}),
      createdAt: a.created_at,
      updatedAt: a.updated_at,
    }));
  }

  // Export agents to CSV
  exportAgentsCSV({ role, active } = {}) {
    const agents = this.exportAgentsJSON({ role, active, includeMetadata: false });

    if (agents.length === 0) {
      return "id,role,active,createdAt,updatedAt\n";
    }

    const headers = Object.keys(agents[0]).join(",");
    const rows = agents.map((a) =>
      Object.values(a)
        .map((v) => {
          if (v === null || v === undefined) return "";
          if (typeof v === "string" && (v.includes(",") || v.includes('"') || v.includes("\n"))) {
            return `"${v.replace(/"/g, '""')}"`;
          }
          return String(v);
        })
        .join(",")
    );

    return [headers, ...rows].join("\n");
  }

  // Export audit logs to JSON
  exportAuditJSON({ startDate, endDate, action, resourceType, limit = 10000 } = {}) {
    const db = getDb();

    let query = `
      SELECT al.*, u.username
      FROM audit_log al
      LEFT JOIN users u ON al.user_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (startDate) {
      query += " AND al.timestamp >= ?";
      params.push(startDate);
    }

    if (endDate) {
      query += " AND al.timestamp <= ?";
      params.push(endDate);
    }

    if (action) {
      query += " AND al.action = ?";
      params.push(action);
    }

    if (resourceType) {
      query += " AND al.resource_type = ?";
      params.push(resourceType);
    }

    query += " ORDER BY al.timestamp DESC LIMIT ?";
    params.push(limit);

    const logs = db.prepare(query).all(...params);

    return logs.map((l) => ({
      id: l.id,
      timestamp: l.timestamp,
      userId: l.user_id,
      username: l.username,
      action: l.action,
      resourceType: l.resource_type,
      resourceId: l.resource_id,
      oldValue: l.old_value ? JSON.parse(l.old_value) : null,
      newValue: l.new_value ? JSON.parse(l.new_value) : null,
      ipAddress: l.ip_address,
      requestId: l.request_id,
    }));
  }

  // Export audit logs to CSV
  exportAuditCSV(options = {}) {
    const logs = this.exportAuditJSON(options);

    if (logs.length === 0) {
      return "id,timestamp,userId,username,action,resourceType,resourceId,ipAddress\n";
    }

    const headers = "id,timestamp,userId,username,action,resourceType,resourceId,ipAddress";
    const rows = logs.map((l) =>
      [l.id, l.timestamp, l.userId, l.username, l.action, l.resourceType, l.resourceId, l.ipAddress]
        .map((v) => {
          if (v === null || v === undefined) return "";
          return String(v);
        })
        .join(",")
    );

    return [headers, ...rows].join("\n");
  }

  // Export users to JSON (admin only)
  exportUsersJSON() {
    const db = getDb();
    const users = db.prepare(`
      SELECT id, username, role, created_at, updated_at
      FROM users
      ORDER BY id
    `).all();

    return users.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      createdAt: u.created_at,
      updatedAt: u.updated_at,
    }));
  }

  // Import agents from JSON
  importAgentsJSON(data, userId = null) {
    const db = getDb();

    if (!Array.isArray(data)) {
      return { error: "Data must be an array of agents" };
    }

    const results = { created: 0, updated: 0, errors: [] };

    const insertStmt = db.prepare(`
      INSERT INTO agents (id, role, active, metadata, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const updateStmt = db.prepare(`
      UPDATE agents
      SET role = ?, active = ?, metadata = ?, updated_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `);

    for (const agent of data) {
      try {
        if (!agent.id || !agent.role) {
          results.errors.push({ id: agent.id, error: "Missing required fields (id, role)" });
          continue;
        }

        const existing = db.prepare("SELECT id FROM agents WHERE id = ?").get(agent.id);

        if (existing) {
          updateStmt.run(
            agent.role,
            agent.active ? 1 : 0,
            JSON.stringify(agent.metadata || {}),
            userId,
            agent.id
          );
          results.updated++;
        } else {
          insertStmt.run(
            agent.id,
            agent.role,
            agent.active ? 1 : 0,
            JSON.stringify(agent.metadata || {}),
            userId,
            userId
          );
          results.created++;
        }
      } catch (err) {
        results.errors.push({ id: agent.id, error: err.message });
      }
    }

    return results;
  }

  // Get export summary/stats
  getExportStats() {
    const db = getDb();

    const safeCount = (table) => {
      try {
        return db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get().count;
      } catch {
        return 0;
      }
    };

    const stats = {
      agents: safeCount("agents"),
      users: safeCount("users"),
      auditLogs: safeCount("audit_log"),
      webhooks: safeCount("webhooks"),
      commands: safeCount("agent_commands"),
      heartbeats: safeCount("agent_heartbeats"),
    };

    return stats;
  }
}

module.exports = new ExportService();
