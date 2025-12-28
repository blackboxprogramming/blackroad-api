const { getDb } = require("../db");

class AgentService {
  // Get all agents with pagination, filtering, sorting
  findAll({ page = 1, limit = 20, sort = "id", order = "asc", role, active, search } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;

    // Build WHERE clause
    const conditions = [];
    const params = [];

    if (role) {
      conditions.push("role = ?");
      params.push(role);
    }

    if (active !== undefined) {
      conditions.push("active = ?");
      params.push(active ? 1 : 0);
    }

    if (search) {
      conditions.push("(id LIKE ? OR role LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Validate sort column
    const allowedSorts = ["id", "role", "active", "created_at", "updated_at"];
    const sortColumn = allowedSorts.includes(sort) ? sort : "id";
    const sortOrder = order === "desc" ? "DESC" : "ASC";

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM agents ${whereClause}`;
    const { total } = db.prepare(countQuery).get(...params);

    // Get paginated results
    const query = `
      SELECT id, role, active, metadata, created_at, updated_at, created_by, updated_by
      FROM agents
      ${whereClause}
      ORDER BY ${sortColumn} ${sortOrder}
      LIMIT ? OFFSET ?
    `;

    const agents = db.prepare(query).all(...params, limit, offset);

    return {
      data: agents.map(this._formatAgent),
      pagination: { page, limit, total },
    };
  }

  // Get single agent by ID
  findById(id) {
    const db = getDb();
    const agent = db
      .prepare(
        `SELECT id, role, active, metadata, created_at, updated_at, created_by, updated_by
         FROM agents WHERE id = ?`
      )
      .get(id);

    return agent ? this._formatAgent(agent) : null;
  }

  // Create new agent
  create(data, userId = null) {
    const db = getDb();
    const { id, role, active = false, metadata = {} } = data;

    // Check if agent already exists
    const existing = db.prepare("SELECT id FROM agents WHERE id = ?").get(id);
    if (existing) {
      return { error: "CONFLICT", message: "Agent already exists" };
    }

    const stmt = db.prepare(`
      INSERT INTO agents (id, role, active, metadata, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, role, active ? 1 : 0, JSON.stringify(metadata), userId, userId);

    return { data: this.findById(id) };
  }

  // Update agent
  update(id, updates, userId = null) {
    const db = getDb();

    // Check if agent exists
    const existing = this.findById(id);
    if (!existing) {
      return { error: "NOT_FOUND", message: "Agent not found" };
    }

    const setClauses = ["updated_at = datetime('now')", "updated_by = ?"];
    const params = [userId];

    if (updates.role !== undefined) {
      setClauses.push("role = ?");
      params.push(updates.role);
    }

    if (updates.active !== undefined) {
      setClauses.push("active = ?");
      params.push(updates.active ? 1 : 0);
    }

    if (updates.metadata !== undefined) {
      setClauses.push("metadata = ?");
      params.push(JSON.stringify(updates.metadata));
    }

    params.push(id);

    const stmt = db.prepare(`UPDATE agents SET ${setClauses.join(", ")} WHERE id = ?`);
    stmt.run(...params);

    return { data: this.findById(id), oldValue: existing };
  }

  // Delete agent
  delete(id) {
    const db = getDb();

    const existing = this.findById(id);
    if (!existing) {
      return { error: "NOT_FOUND", message: "Agent not found" };
    }

    db.prepare("DELETE FROM agents WHERE id = ?").run(id);

    return { data: existing };
  }

  // Format agent from database row
  _formatAgent(row) {
    return {
      id: row.id,
      role: row.role,
      active: Boolean(row.active),
      metadata: JSON.parse(row.metadata || "{}"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
    };
  }
}

module.exports = new AgentService();
