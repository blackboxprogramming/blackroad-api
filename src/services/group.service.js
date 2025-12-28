const { getDb } = require("../db");
const websocketService = require("./websocket.service");
const webhookService = require("./webhook.service");

class GroupService {
  // Initialize group tables
  initTable() {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        color TEXT DEFAULT '#6366f1',
        metadata TEXT DEFAULT '{}',
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS agent_group_members (
        group_id INTEGER REFERENCES agent_groups(id) ON DELETE CASCADE,
        agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
        added_at TEXT DEFAULT (datetime('now')),
        added_by INTEGER REFERENCES users(id),
        PRIMARY KEY (group_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS agent_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        color TEXT DEFAULT '#8b5cf6',
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS agent_tag_assignments (
        tag_id INTEGER REFERENCES agent_tags(id) ON DELETE CASCADE,
        agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
        assigned_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (tag_id, agent_id)
      );

      CREATE INDEX IF NOT EXISTS idx_group_members_agent ON agent_group_members(agent_id);
      CREATE INDEX IF NOT EXISTS idx_tag_assignments_agent ON agent_tag_assignments(agent_id);
    `);
  }

  // ==================== Groups ====================

  // Create a group
  createGroup(data, userId) {
    const db = getDb();
    const { name, description, color, metadata = {} } = data;

    try {
      const stmt = db.prepare(`
        INSERT INTO agent_groups (name, description, color, metadata, created_by)
        VALUES (?, ?, ?, ?, ?)
      `);
      const result = stmt.run(name, description, color || "#6366f1", JSON.stringify(metadata), userId);

      const group = this.findGroupById(result.lastInsertRowid);
      webhookService.trigger("group.created", { group });
      return { data: group };
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { error: "CONFLICT", message: "Group name already exists" };
      }
      throw err;
    }
  }

  // Find all groups
  findAllGroups({ page = 1, limit = 50 } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;

    const total = db.prepare("SELECT COUNT(*) as count FROM agent_groups").get().count;

    const groups = db.prepare(`
      SELECT g.*,
        (SELECT COUNT(*) FROM agent_group_members WHERE group_id = g.id) as member_count
      FROM agent_groups g
      ORDER BY g.name ASC
      LIMIT ? OFFSET ?
    `).all(limit, offset);

    return {
      data: groups.map(this._formatGroup),
      pagination: { page, limit, total },
    };
  }

  // Find group by ID
  findGroupById(id) {
    const db = getDb();
    const group = db.prepare(`
      SELECT g.*,
        (SELECT COUNT(*) FROM agent_group_members WHERE group_id = g.id) as member_count
      FROM agent_groups g
      WHERE g.id = ?
    `).get(id);

    return group ? this._formatGroup(group) : null;
  }

  // Update group
  updateGroup(id, data, _userId) {
    const db = getDb();
    const existing = this.findGroupById(id);
    if (!existing) {
      return { error: "NOT_FOUND", message: "Group not found" };
    }

    const updates = [];
    const params = [];

    if (data.name !== undefined) {
      updates.push("name = ?");
      params.push(data.name);
    }
    if (data.description !== undefined) {
      updates.push("description = ?");
      params.push(data.description);
    }
    if (data.color !== undefined) {
      updates.push("color = ?");
      params.push(data.color);
    }
    if (data.metadata !== undefined) {
      updates.push("metadata = ?");
      params.push(JSON.stringify(data.metadata));
    }

    updates.push("updated_at = datetime('now')");
    params.push(id);

    try {
      db.prepare(`UPDATE agent_groups SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      return { data: this.findGroupById(id), oldValue: existing };
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { error: "CONFLICT", message: "Group name already exists" };
      }
      throw err;
    }
  }

  // Delete group
  deleteGroup(id) {
    const db = getDb();
    const existing = this.findGroupById(id);
    if (!existing) {
      return { error: "NOT_FOUND", message: "Group not found" };
    }

    db.prepare("DELETE FROM agent_groups WHERE id = ?").run(id);
    webhookService.trigger("group.deleted", { group: existing });
    return { data: existing };
  }

  // Get group members
  getGroupMembers(groupId) {
    const db = getDb();
    const members = db.prepare(`
      SELECT a.*, m.added_at, u.username as added_by_username
      FROM agent_group_members m
      JOIN agents a ON m.agent_id = a.id
      LEFT JOIN users u ON m.added_by = u.id
      WHERE m.group_id = ?
      ORDER BY a.id
    `).all(groupId);

    return members.map((m) => ({
      id: m.id,
      role: m.role,
      active: Boolean(m.active),
      metadata: JSON.parse(m.metadata || "{}"),
      addedAt: m.added_at,
      addedBy: m.added_by_username,
    }));
  }

  // Add agent to group
  addAgentToGroup(groupId, agentId, userId) {
    const db = getDb();

    // Verify group exists
    const group = this.findGroupById(groupId);
    if (!group) {
      return { error: "NOT_FOUND", message: "Group not found" };
    }

    // Verify agent exists
    const agent = db.prepare("SELECT id FROM agents WHERE id = ?").get(agentId);
    if (!agent) {
      return { error: "NOT_FOUND", message: "Agent not found" };
    }

    try {
      db.prepare(`
        INSERT INTO agent_group_members (group_id, agent_id, added_by)
        VALUES (?, ?, ?)
      `).run(groupId, agentId, userId);

      websocketService.broadcast(`agents:${agentId}`, { type: "group_added", groupId, groupName: group.name });
      return { data: { groupId, agentId, added: true } };
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        return { error: "CONFLICT", message: "Agent already in group" };
      }
      throw err;
    }
  }

  // Remove agent from group
  removeAgentFromGroup(groupId, agentId) {
    const db = getDb();

    const result = db.prepare("DELETE FROM agent_group_members WHERE group_id = ? AND agent_id = ?")
      .run(groupId, agentId);

    if (result.changes === 0) {
      return { error: "NOT_FOUND", message: "Agent not in group" };
    }

    websocketService.broadcast(`agents:${agentId}`, { type: "group_removed", groupId });
    return { data: { groupId, agentId, removed: true } };
  }

  // Get groups for an agent
  getAgentGroups(agentId) {
    const db = getDb();
    const groups = db.prepare(`
      SELECT g.*, m.added_at
      FROM agent_groups g
      JOIN agent_group_members m ON g.id = m.group_id
      WHERE m.agent_id = ?
      ORDER BY g.name
    `).all(agentId);

    return groups.map(this._formatGroup);
  }

  // ==================== Tags ====================

  // Create a tag
  createTag(name, color = "#8b5cf6") {
    const db = getDb();

    try {
      const result = db.prepare("INSERT INTO agent_tags (name, color) VALUES (?, ?)").run(name, color);
      return { data: { id: result.lastInsertRowid, name, color } };
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { error: "CONFLICT", message: "Tag already exists" };
      }
      throw err;
    }
  }

  // Find all tags
  findAllTags() {
    const db = getDb();
    const tags = db.prepare(`
      SELECT t.*,
        (SELECT COUNT(*) FROM agent_tag_assignments WHERE tag_id = t.id) as usage_count
      FROM agent_tags t
      ORDER BY t.name
    `).all();

    return tags.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      usageCount: t.usage_count,
      createdAt: t.created_at,
    }));
  }

  // Delete tag
  deleteTag(id) {
    const db = getDb();
    const result = db.prepare("DELETE FROM agent_tags WHERE id = ?").run(id);

    if (result.changes === 0) {
      return { error: "NOT_FOUND", message: "Tag not found" };
    }

    return { data: { id, deleted: true } };
  }

  // Assign tag to agent
  assignTagToAgent(tagId, agentId) {
    const db = getDb();

    try {
      db.prepare("INSERT INTO agent_tag_assignments (tag_id, agent_id) VALUES (?, ?)").run(tagId, agentId);
      return { data: { tagId, agentId, assigned: true } };
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        return { error: "CONFLICT", message: "Tag already assigned" };
      }
      if (err.code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
        return { error: "NOT_FOUND", message: "Tag or agent not found" };
      }
      throw err;
    }
  }

  // Remove tag from agent
  removeTagFromAgent(tagId, agentId) {
    const db = getDb();
    const result = db.prepare("DELETE FROM agent_tag_assignments WHERE tag_id = ? AND agent_id = ?")
      .run(tagId, agentId);

    if (result.changes === 0) {
      return { error: "NOT_FOUND", message: "Tag not assigned to agent" };
    }

    return { data: { tagId, agentId, removed: true } };
  }

  // Get tags for an agent
  getAgentTags(agentId) {
    const db = getDb();
    return db.prepare(`
      SELECT t.*
      FROM agent_tags t
      JOIN agent_tag_assignments a ON t.id = a.tag_id
      WHERE a.agent_id = ?
      ORDER BY t.name
    `).all(agentId).map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
    }));
  }

  // Get agents by tag
  getAgentsByTag(tagId, { page = 1, limit = 50 } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;

    const total = db.prepare("SELECT COUNT(*) as count FROM agent_tag_assignments WHERE tag_id = ?")
      .get(tagId).count;

    const agents = db.prepare(`
      SELECT a.*
      FROM agents a
      JOIN agent_tag_assignments t ON a.id = t.agent_id
      WHERE t.tag_id = ?
      ORDER BY a.id
      LIMIT ? OFFSET ?
    `).all(tagId, limit, offset);

    return {
      data: agents.map((a) => ({
        id: a.id,
        role: a.role,
        active: Boolean(a.active),
        metadata: JSON.parse(a.metadata || "{}"),
        createdAt: a.created_at,
      })),
      pagination: { page, limit, total },
    };
  }

  _formatGroup(row) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      color: row.color,
      metadata: JSON.parse(row.metadata || "{}"),
      memberCount: row.member_count || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = new GroupService();
