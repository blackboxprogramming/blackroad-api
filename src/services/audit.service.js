const { getDb } = require("../db");

class AuditService {
  // Log an action
  log({ userId, action, resourceType, resourceId, oldValue, newValue, ipAddress, requestId }) {
    const db = getDb();

    const stmt = db.prepare(`
      INSERT INTO audit_log (user_id, action, resource_type, resource_id, old_value, new_value, ip_address, request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      userId,
      action,
      resourceType,
      resourceId,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null,
      ipAddress,
      requestId
    );
  }

  // Get audit logs with filtering
  findAll({ page = 1, limit = 50, userId, action, resourceType, resourceId, startDate, endDate } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];

    if (userId) {
      conditions.push("user_id = ?");
      params.push(userId);
    }

    if (action) {
      conditions.push("action = ?");
      params.push(action);
    }

    if (resourceType) {
      conditions.push("resource_type = ?");
      params.push(resourceType);
    }

    if (resourceId) {
      conditions.push("resource_id = ?");
      params.push(resourceId);
    }

    if (startDate) {
      conditions.push("timestamp >= ?");
      params.push(startDate);
    }

    if (endDate) {
      conditions.push("timestamp <= ?");
      params.push(endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countQuery = `SELECT COUNT(*) as total FROM audit_log ${whereClause}`;
    const { total } = db.prepare(countQuery).get(...params);

    const query = `
      SELECT al.*, u.username
      FROM audit_log al
      LEFT JOIN users u ON al.user_id = u.id
      ${whereClause}
      ORDER BY al.timestamp DESC
      LIMIT ? OFFSET ?
    `;

    const logs = db.prepare(query).all(...params, limit, offset);

    return {
      data: logs.map((log) => ({
        id: log.id,
        timestamp: log.timestamp,
        userId: log.user_id,
        username: log.username,
        action: log.action,
        resourceType: log.resource_type,
        resourceId: log.resource_id,
        oldValue: log.old_value ? JSON.parse(log.old_value) : null,
        newValue: log.new_value ? JSON.parse(log.new_value) : null,
        ipAddress: log.ip_address,
        requestId: log.request_id,
      })),
      pagination: { page, limit, total },
    };
  }
}

module.exports = new AuditService();
