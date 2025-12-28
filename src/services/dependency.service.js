const { getDb } = require("../db");
const websocketService = require("./websocket.service");

class DependencyService {
  initTable() {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        depends_on TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        dependency_type TEXT DEFAULT 'required', -- 'required', 'optional', 'soft'
        description TEXT,
        health_check INTEGER DEFAULT 1, -- Check dependent health before starting
        auto_restart INTEGER DEFAULT 0, -- Restart if dependency restarts
        start_delay_seconds INTEGER DEFAULT 0, -- Wait after dependency starts
        config TEXT DEFAULT '{}',
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(agent_id, depends_on)
      );

      CREATE TABLE IF NOT EXISTS dependency_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        depends_on TEXT NOT NULL,
        event_type TEXT NOT NULL, -- 'dependency_up', 'dependency_down', 'cascade_restart', 'health_check_failed'
        details TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_dependencies_agent ON agent_dependencies(agent_id);
      CREATE INDEX IF NOT EXISTS idx_dependencies_depends_on ON agent_dependencies(depends_on);
      CREATE INDEX IF NOT EXISTS idx_dependency_events_agent ON dependency_events(agent_id);
    `);
  }

  // Add a dependency
  addDependency(data, userId) {
    const db = getDb();
    const {
      agent_id,
      depends_on,
      dependency_type = "required",
      description,
      health_check = true,
      auto_restart = false,
      start_delay_seconds = 0,
      config = {},
    } = data;

    if (agent_id === depends_on) {
      return { error: "VALIDATION", message: "Agent cannot depend on itself" };
    }

    // Check for circular dependency
    if (this._wouldCreateCycle(agent_id, depends_on)) {
      return { error: "CIRCULAR", message: "This would create a circular dependency" };
    }

    // Verify both agents exist
    const agentExists = db.prepare("SELECT id FROM agents WHERE id = ?").get(agent_id);
    const dependsOnExists = db.prepare("SELECT id FROM agents WHERE id = ?").get(depends_on);

    if (!agentExists) {
      return { error: "NOT_FOUND", message: `Agent ${agent_id} not found` };
    }
    if (!dependsOnExists) {
      return { error: "NOT_FOUND", message: `Agent ${depends_on} not found` };
    }

    try {
      const result = db.prepare(`
        INSERT INTO agent_dependencies (agent_id, depends_on, dependency_type, description, health_check, auto_restart, start_delay_seconds, config, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        agent_id,
        depends_on,
        dependency_type,
        description || null,
        health_check ? 1 : 0,
        auto_restart ? 1 : 0,
        start_delay_seconds,
        JSON.stringify(config),
        userId
      );

      websocketService.broadcast(`agents:${agent_id}`, {
        type: "dependency_added",
        dependsOn: depends_on,
      });

      return { data: this.findById(result.lastInsertRowid) };
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { error: "CONFLICT", message: "Dependency already exists" };
      }
      throw err;
    }
  }

  // Find dependency by ID
  findById(id) {
    const db = getDb();
    const dep = db.prepare(`
      SELECT d.*, u.username as created_by_username
      FROM agent_dependencies d
      LEFT JOIN users u ON d.created_by = u.id
      WHERE d.id = ?
    `).get(id);

    return dep ? this._format(dep) : null;
  }

  // Get dependencies for an agent
  getDependencies(agentId) {
    const db = getDb();
    const deps = db.prepare(`
      SELECT d.*, a.role as depends_on_role, a.active as depends_on_active
      FROM agent_dependencies d
      JOIN agents a ON d.depends_on = a.id
      WHERE d.agent_id = ?
      ORDER BY d.dependency_type, d.depends_on
    `).all(agentId);

    return deps.map((d) => ({
      ...this._format(d),
      dependsOnRole: d.depends_on_role,
      dependsOnActive: Boolean(d.depends_on_active),
    }));
  }

  // Get dependents of an agent (who depends on this agent)
  getDependents(agentId) {
    const db = getDb();
    const deps = db.prepare(`
      SELECT d.*, a.role as agent_role, a.active as agent_active
      FROM agent_dependencies d
      JOIN agents a ON d.agent_id = a.id
      WHERE d.depends_on = ?
      ORDER BY d.dependency_type, d.agent_id
    `).all(agentId);

    return deps.map((d) => ({
      ...this._format(d),
      agentRole: d.agent_role,
      agentActive: Boolean(d.agent_active),
    }));
  }

  // Remove a dependency
  removeDependency(agentId, dependsOn) {
    const db = getDb();
    const result = db.prepare(`
      DELETE FROM agent_dependencies
      WHERE agent_id = ? AND depends_on = ?
    `).run(agentId, dependsOn);

    if (result.changes === 0) {
      return { error: "NOT_FOUND", message: "Dependency not found" };
    }

    websocketService.broadcast(`agents:${agentId}`, {
      type: "dependency_removed",
      dependsOn,
    });

    return { data: { agentId, dependsOn, removed: true } };
  }

  // Update a dependency
  updateDependency(id, data) {
    const db = getDb();
    const existing = this.findById(id);

    if (!existing) {
      return { error: "NOT_FOUND", message: "Dependency not found" };
    }

    const updates = [];
    const params = [];

    if (data.dependency_type !== undefined) {
      updates.push("dependency_type = ?");
      params.push(data.dependency_type);
    }
    if (data.description !== undefined) {
      updates.push("description = ?");
      params.push(data.description);
    }
    if (data.health_check !== undefined) {
      updates.push("health_check = ?");
      params.push(data.health_check ? 1 : 0);
    }
    if (data.auto_restart !== undefined) {
      updates.push("auto_restart = ?");
      params.push(data.auto_restart ? 1 : 0);
    }
    if (data.start_delay_seconds !== undefined) {
      updates.push("start_delay_seconds = ?");
      params.push(data.start_delay_seconds);
    }
    if (data.config !== undefined) {
      updates.push("config = ?");
      params.push(JSON.stringify(data.config));
    }

    if (updates.length === 0) {
      return { data: existing };
    }

    params.push(id);
    db.prepare(`UPDATE agent_dependencies SET ${updates.join(", ")} WHERE id = ?`).run(...params);

    return { data: this.findById(id), oldValue: existing };
  }

  // Get full dependency graph
  getGraph() {
    const db = getDb();

    const agents = db.prepare(`
      SELECT id, role, active FROM agents
    `).all();

    const dependencies = db.prepare(`
      SELECT agent_id, depends_on, dependency_type FROM agent_dependencies
    `).all();

    const nodes = agents.map((a) => ({
      id: a.id,
      role: a.role,
      active: Boolean(a.active),
      dependencyCount: dependencies.filter((d) => d.agent_id === a.id).length,
      dependentCount: dependencies.filter((d) => d.depends_on === a.id).length,
    }));

    const edges = dependencies.map((d) => ({
      from: d.agent_id,
      to: d.depends_on,
      type: d.dependency_type,
    }));

    return { nodes, edges };
  }

  // Get start order (topological sort)
  getStartOrder() {
    const db = getDb();

    const agents = db.prepare("SELECT id FROM agents").all().map((a) => a.id);
    const dependencies = db.prepare("SELECT agent_id, depends_on FROM agent_dependencies").all();

    // Build adjacency list
    const graph = new Map();
    const inDegree = new Map();

    for (const agent of agents) {
      graph.set(agent, []);
      inDegree.set(agent, 0);
    }

    for (const dep of dependencies) {
      if (graph.has(dep.depends_on)) {
        graph.get(dep.depends_on).push(dep.agent_id);
      }
      inDegree.set(dep.agent_id, (inDegree.get(dep.agent_id) || 0) + 1);
    }

    // Kahn's algorithm for topological sort
    const queue = [];
    const result = [];
    const levels = new Map();

    for (const [agent, degree] of inDegree) {
      if (degree === 0) {
        queue.push(agent);
        levels.set(agent, 0);
      }
    }

    while (queue.length > 0) {
      const current = queue.shift();
      result.push(current);

      const currentLevel = levels.get(current);

      for (const dependent of graph.get(current) || []) {
        inDegree.set(dependent, inDegree.get(dependent) - 1);
        if (inDegree.get(dependent) === 0) {
          queue.push(dependent);
          levels.set(dependent, currentLevel + 1);
        }
      }
    }

    // Check for cycles
    if (result.length !== agents.length) {
      const cyclicAgents = agents.filter((a) => !result.includes(a));
      return {
        order: result,
        levels: Object.fromEntries(levels),
        hasCycle: true,
        cyclicAgents,
      };
    }

    return {
      order: result,
      levels: Object.fromEntries(levels),
      hasCycle: false,
    };
  }

  // Check if adding a dependency would create a cycle
  _wouldCreateCycle(agentId, dependsOn) {
    const db = getDb();

    // BFS to check if dependsOn can reach agentId
    const visited = new Set();
    const queue = [dependsOn];

    while (queue.length > 0) {
      const current = queue.shift();

      if (current === agentId) {
        return true;
      }

      if (visited.has(current)) {
        continue;
      }
      visited.add(current);

      const deps = db.prepare(`
        SELECT depends_on FROM agent_dependencies WHERE agent_id = ?
      `).all(current);

      for (const dep of deps) {
        queue.push(dep.depends_on);
      }
    }

    return false;
  }

  // Get health status of dependencies for an agent
  getDependencyHealth(agentId) {
    const db = getDb();
    const deps = this.getDependencies(agentId);

    const healthStatus = deps.map((dep) => {
      // Check agent is active
      const agent = db.prepare("SELECT active FROM agents WHERE id = ?").get(dep.dependsOn);

      // Check for recent heartbeat
      let hasHeartbeat = false;
      try {
        const heartbeat = db.prepare(`
          SELECT 1 FROM agent_heartbeats
          WHERE agent_id = ? AND timestamp > datetime('now', '-5 minutes')
        `).get(dep.dependsOn);
        hasHeartbeat = Boolean(heartbeat);
      } catch {
        // Table might not exist
      }

      const isHealthy = agent?.active && (dep.dependencyType !== "required" || hasHeartbeat);

      return {
        dependsOn: dep.dependsOn,
        type: dep.dependencyType,
        isActive: Boolean(agent?.active),
        hasHeartbeat,
        isHealthy,
        healthCheck: dep.healthCheck,
      };
    });

    const allHealthy = healthStatus.every((s) => s.isHealthy || s.type !== "required");

    return {
      agentId,
      dependencies: healthStatus,
      allHealthy,
      requiredHealthy: healthStatus
        .filter((s) => s.type === "required")
        .every((s) => s.isHealthy),
    };
  }

  // Log a dependency event
  logEvent(agentId, dependsOn, eventType, details = {}) {
    const db = getDb();
    db.prepare(`
      INSERT INTO dependency_events (agent_id, depends_on, event_type, details)
      VALUES (?, ?, ?, ?)
    `).run(agentId, dependsOn, eventType, JSON.stringify(details));
  }

  // Get dependency events
  getEvents({ agentId, dependsOn, eventType, page = 1, limit = 50 } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;
    const conditions = [];
    const params = [];

    if (agentId) {
      conditions.push("agent_id = ?");
      params.push(agentId);
    }
    if (dependsOn) {
      conditions.push("depends_on = ?");
      params.push(dependsOn);
    }
    if (eventType) {
      conditions.push("event_type = ?");
      params.push(eventType);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const total = db.prepare(`SELECT COUNT(*) as count FROM dependency_events ${where}`).get(...params).count;

    const events = db.prepare(`
      SELECT * FROM dependency_events
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return {
      data: events.map((e) => ({
        id: e.id,
        agentId: e.agent_id,
        dependsOn: e.depends_on,
        eventType: e.event_type,
        details: JSON.parse(e.details || "{}"),
        createdAt: e.created_at,
      })),
      pagination: { page, limit, total },
    };
  }

  _format(row) {
    return {
      id: row.id,
      agentId: row.agent_id,
      dependsOn: row.depends_on,
      dependencyType: row.dependency_type,
      description: row.description,
      healthCheck: Boolean(row.health_check),
      autoRestart: Boolean(row.auto_restart),
      startDelaySeconds: row.start_delay_seconds,
      config: JSON.parse(row.config || "{}"),
      createdBy: row.created_by,
      createdByUsername: row.created_by_username,
      createdAt: row.created_at,
    };
  }
}

module.exports = new DependencyService();
