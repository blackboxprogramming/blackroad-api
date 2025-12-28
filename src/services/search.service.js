const { getDb } = require("../db");

class SearchService {
  // Unified search across multiple entities
  search(query, { types = ["agents", "groups", "tags", "commands", "users"], limit = 20, userId } = {}) {
    const results = {
      query,
      total: 0,
      results: [],
    };

    if (!query || query.length < 2) {
      return results;
    }

    const searchPattern = `%${query}%`;

    for (const type of types) {
      let typeResults = [];

      switch (type) {
        case "agents":
          typeResults = this._searchAgents(searchPattern, limit);
          break;
        case "groups":
          typeResults = this._searchGroups(searchPattern, limit);
          break;
        case "tags":
          typeResults = this._searchTags(searchPattern, limit);
          break;
        case "commands":
          typeResults = this._searchCommands(searchPattern, limit);
          break;
        case "users":
          typeResults = this._searchUsers(searchPattern, limit, userId);
          break;
        case "templates":
          typeResults = this._searchTemplates(searchPattern, limit);
          break;
        case "webhooks":
          typeResults = this._searchWebhooks(searchPattern, limit);
          break;
      }

      results.results.push(...typeResults);
      results.total += typeResults.length;
    }

    // Sort by relevance (exact matches first, then partial)
    results.results.sort((a, b) => {
      const aExact = a.matchedField.toLowerCase() === query.toLowerCase();
      const bExact = b.matchedField.toLowerCase() === query.toLowerCase();
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
      return 0;
    });

    return results;
  }

  // Advanced agent search with filters
  searchAgents({
    query,
    role,
    active,
    groupId,
    tagId,
    hasHeartbeat,
    createdAfter,
    createdBefore,
    page = 1,
    limit = 50,
    sortBy = "id",
    sortOrder = "asc",
  } = {}) {
    const db = getDb();
    const conditions = [];
    const params = [];
    const offset = (page - 1) * limit;

    if (query) {
      conditions.push("(a.id LIKE ? OR a.role LIKE ? OR a.metadata LIKE ?)");
      const pattern = `%${query}%`;
      params.push(pattern, pattern, pattern);
    }

    if (role) {
      conditions.push("a.role = ?");
      params.push(role);
    }

    if (active !== undefined) {
      conditions.push("a.active = ?");
      params.push(active ? 1 : 0);
    }

    if (groupId) {
      conditions.push("EXISTS (SELECT 1 FROM agent_group_members gm WHERE gm.agent_id = a.id AND gm.group_id = ?)");
      params.push(groupId);
    }

    if (tagId) {
      conditions.push("EXISTS (SELECT 1 FROM agent_tag_assignments ta WHERE ta.agent_id = a.id AND ta.tag_id = ?)");
      params.push(tagId);
    }

    if (hasHeartbeat !== undefined) {
      if (hasHeartbeat) {
        conditions.push("EXISTS (SELECT 1 FROM agent_heartbeats h WHERE h.agent_id = a.id AND h.timestamp > datetime('now', '-5 minutes'))");
      } else {
        conditions.push("NOT EXISTS (SELECT 1 FROM agent_heartbeats h WHERE h.agent_id = a.id AND h.timestamp > datetime('now', '-5 minutes'))");
      }
    }

    if (createdAfter) {
      conditions.push("a.created_at >= ?");
      params.push(createdAfter);
    }

    if (createdBefore) {
      conditions.push("a.created_at <= ?");
      params.push(createdBefore);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Validate sort column
    const validSortColumns = ["id", "role", "active", "created_at", "updated_at"];
    const safeSort = validSortColumns.includes(sortBy) ? sortBy : "id";
    const safeOrder = sortOrder.toLowerCase() === "desc" ? "DESC" : "ASC";

    const total = db.prepare(`SELECT COUNT(*) as count FROM agents a ${where}`).get(...params).count;

    const agents = db.prepare(`
      SELECT a.*,
        (SELECT MAX(timestamp) FROM agent_heartbeats WHERE agent_id = a.id) as last_heartbeat,
        (SELECT COUNT(*) FROM agent_group_members WHERE agent_id = a.id) as group_count,
        (SELECT COUNT(*) FROM agent_tag_assignments WHERE agent_id = a.id) as tag_count
      FROM agents a
      ${where}
      ORDER BY a.${safeSort} ${safeOrder}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return {
      data: agents.map((a) => ({
        id: a.id,
        role: a.role,
        active: Boolean(a.active),
        metadata: JSON.parse(a.metadata || "{}"),
        lastHeartbeat: a.last_heartbeat,
        groupCount: a.group_count,
        tagCount: a.tag_count,
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      })),
      pagination: { page, limit, total },
      filters: { query, role, active, groupId, tagId, hasHeartbeat, createdAfter, createdBefore },
    };
  }

  // Search audit logs
  searchAuditLogs({
    query,
    userId,
    action,
    resourceType,
    resourceId,
    startDate,
    endDate,
    page = 1,
    limit = 50,
  } = {}) {
    const db = getDb();
    const conditions = [];
    const params = [];
    const offset = (page - 1) * limit;

    if (query) {
      conditions.push("(al.new_value LIKE ? OR al.old_value LIKE ? OR al.resource_id LIKE ?)");
      const pattern = `%${query}%`;
      params.push(pattern, pattern, pattern);
    }

    if (userId) {
      conditions.push("al.user_id = ?");
      params.push(userId);
    }

    if (action) {
      conditions.push("al.action = ?");
      params.push(action);
    }

    if (resourceType) {
      conditions.push("al.resource_type = ?");
      params.push(resourceType);
    }

    if (resourceId) {
      conditions.push("al.resource_id = ?");
      params.push(resourceId);
    }

    if (startDate) {
      conditions.push("al.timestamp >= ?");
      params.push(startDate);
    }

    if (endDate) {
      conditions.push("al.timestamp <= ?");
      params.push(endDate);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const total = db.prepare(`SELECT COUNT(*) as count FROM audit_log al ${where}`).get(...params).count;

    const logs = db.prepare(`
      SELECT al.*, u.username
      FROM audit_log al
      LEFT JOIN users u ON al.user_id = u.id
      ${where}
      ORDER BY al.timestamp DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return {
      data: logs.map((l) => ({
        id: l.id,
        userId: l.user_id,
        username: l.username,
        action: l.action,
        resourceType: l.resource_type,
        resourceId: l.resource_id,
        oldValue: JSON.parse(l.old_value || "null"),
        newValue: JSON.parse(l.new_value || "null"),
        ipAddress: l.ip_address,
        requestId: l.request_id,
        timestamp: l.timestamp,
      })),
      pagination: { page, limit, total },
    };
  }

  // Get search suggestions
  getSuggestions(query, type = "all") {
    if (!query || query.length < 1) {
      return [];
    }

    const suggestions = [];
    const pattern = `${query}%`;
    const db = getDb();

    if (type === "all" || type === "agents") {
      const agents = db.prepare("SELECT DISTINCT id FROM agents WHERE id LIKE ? LIMIT 5").all(pattern);
      suggestions.push(...agents.map((a) => ({ type: "agent", value: a.id })));
    }

    if (type === "all" || type === "roles") {
      const roles = db.prepare("SELECT DISTINCT role FROM agents WHERE role LIKE ? LIMIT 5").all(pattern);
      suggestions.push(...roles.map((r) => ({ type: "role", value: r.role })));
    }

    if (type === "all" || type === "groups") {
      const groups = db.prepare("SELECT id, name FROM agent_groups WHERE name LIKE ? LIMIT 5").all(pattern);
      suggestions.push(...groups.map((g) => ({ type: "group", value: g.name, id: g.id })));
    }

    if (type === "all" || type === "tags") {
      const tags = db.prepare("SELECT id, name FROM agent_tags WHERE name LIKE ? LIMIT 5").all(pattern);
      suggestions.push(...tags.map((t) => ({ type: "tag", value: t.name, id: t.id })));
    }

    return suggestions.slice(0, 10);
  }

  _searchAgents(pattern, limit) {
    const db = getDb();
    try {
      const agents = db.prepare(`
        SELECT id, role, active, metadata FROM agents
        WHERE id LIKE ? OR role LIKE ? OR metadata LIKE ?
        LIMIT ?
      `).all(pattern, pattern, pattern, limit);

      return agents.map((a) => ({
        type: "agent",
        id: a.id,
        title: a.id,
        subtitle: a.role,
        matchedField: a.id.includes(pattern.replace(/%/g, "")) ? a.id : a.role,
        active: Boolean(a.active),
      }));
    } catch {
      return [];
    }
  }

  _searchGroups(pattern, limit) {
    const db = getDb();
    try {
      const groups = db.prepare(`
        SELECT id, name, description, color FROM agent_groups
        WHERE name LIKE ? OR description LIKE ?
        LIMIT ?
      `).all(pattern, pattern, limit);

      return groups.map((g) => ({
        type: "group",
        id: g.id,
        title: g.name,
        subtitle: g.description,
        matchedField: g.name,
        color: g.color,
      }));
    } catch {
      return [];
    }
  }

  _searchTags(pattern, limit) {
    const db = getDb();
    try {
      const tags = db.prepare(`
        SELECT id, name, color FROM agent_tags
        WHERE name LIKE ?
        LIMIT ?
      `).all(pattern, limit);

      return tags.map((t) => ({
        type: "tag",
        id: t.id,
        title: t.name,
        matchedField: t.name,
        color: t.color,
      }));
    } catch {
      return [];
    }
  }

  _searchCommands(pattern, limit) {
    const db = getDb();
    try {
      const commands = db.prepare(`
        SELECT id, agent_id, command, status FROM agent_commands
        WHERE agent_id LIKE ? OR command LIKE ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(pattern, pattern, limit);

      return commands.map((c) => ({
        type: "command",
        id: c.id,
        title: `${c.command} → ${c.agent_id}`,
        subtitle: c.status,
        matchedField: c.agent_id,
      }));
    } catch {
      return [];
    }
  }

  _searchUsers(pattern, limit, _currentUserId) {
    const db = getDb();
    try {
      const users = db.prepare(`
        SELECT id, username, email, role FROM users
        WHERE username LIKE ? OR email LIKE ?
        LIMIT ?
      `).all(pattern, pattern, limit);

      return users.map((u) => ({
        type: "user",
        id: u.id,
        title: u.username,
        subtitle: u.email,
        matchedField: u.username,
        role: u.role,
      }));
    } catch {
      return [];
    }
  }

  _searchTemplates(pattern, limit) {
    const db = getDb();
    try {
      const templates = db.prepare(`
        SELECT id, name, description, role FROM agent_templates
        WHERE name LIKE ? OR description LIKE ?
        LIMIT ?
      `).all(pattern, pattern, limit);

      return templates.map((t) => ({
        type: "template",
        id: t.id,
        title: t.name,
        subtitle: t.description || t.role,
        matchedField: t.name,
      }));
    } catch {
      return [];
    }
  }

  _searchWebhooks(pattern, limit) {
    const db = getDb();
    try {
      const webhooks = db.prepare(`
        SELECT id, name, url, events FROM webhooks
        WHERE name LIKE ? OR url LIKE ?
        LIMIT ?
      `).all(pattern, pattern, limit);

      return webhooks.map((w) => ({
        type: "webhook",
        id: w.id,
        title: w.name,
        subtitle: w.url,
        matchedField: w.name,
      }));
    } catch {
      return [];
    }
  }
}

module.exports = new SearchService();
