const { getDb } = require("../db");
const webhookService = require("./webhook.service");

class TemplateService {
  initTable() {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        role TEXT DEFAULT 'agent',
        default_metadata TEXT DEFAULT '{}',
        config TEXT DEFAULT '{}', -- Default configuration
        tags TEXT DEFAULT '[]', -- Array of tag IDs to auto-assign
        groups TEXT DEFAULT '[]', -- Array of group IDs to auto-add
        is_default INTEGER DEFAULT 0,
        usage_count INTEGER DEFAULT 0,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS template_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER REFERENCES agent_templates(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        role TEXT,
        default_metadata TEXT,
        config TEXT,
        tags TEXT,
        groups TEXT,
        change_notes TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(template_id, version)
      );

      CREATE INDEX IF NOT EXISTS idx_templates_name ON agent_templates(name);
      CREATE INDEX IF NOT EXISTS idx_template_versions_template ON template_versions(template_id);
    `);
  }

  // Create a template
  create(data, userId) {
    const db = getDb();
    const { name, description, role, default_metadata = {}, config = {}, tags = [], groups = [], is_default = false } = data;

    // If setting as default, unset other defaults
    if (is_default) {
      db.prepare("UPDATE agent_templates SET is_default = 0").run();
    }

    try {
      const result = db.prepare(`
        INSERT INTO agent_templates (name, description, role, default_metadata, config, tags, groups, is_default, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        name,
        description || null,
        role || "agent",
        JSON.stringify(default_metadata),
        JSON.stringify(config),
        JSON.stringify(tags),
        JSON.stringify(groups),
        is_default ? 1 : 0,
        userId
      );

      const template = this.findById(result.lastInsertRowid);

      // Create initial version
      this._createVersion(template.id, 1, template, userId, "Initial version");

      webhookService.trigger("template.created", { template });
      return { data: template };
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { error: "CONFLICT", message: "Template name already exists" };
      }
      throw err;
    }
  }

  // Find template by ID
  findById(id) {
    const db = getDb();
    const template = db.prepare(`
      SELECT t.*, u.username as created_by_username
      FROM agent_templates t
      LEFT JOIN users u ON t.created_by = u.id
      WHERE t.id = ?
    `).get(id);

    return template ? this._format(template) : null;
  }

  // Find all templates
  findAll({ page = 1, limit = 50, search } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;
    const conditions = [];
    const params = [];

    if (search) {
      conditions.push("(t.name LIKE ? OR t.description LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const total = db.prepare(`SELECT COUNT(*) as count FROM agent_templates t ${where}`).get(...params).count;

    const templates = db.prepare(`
      SELECT t.*, u.username as created_by_username
      FROM agent_templates t
      LEFT JOIN users u ON t.created_by = u.id
      ${where}
      ORDER BY t.is_default DESC, t.usage_count DESC, t.name ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return {
      data: templates.map(this._format),
      pagination: { page, limit, total },
    };
  }

  // Get default template
  getDefault() {
    const db = getDb();
    const template = db.prepare(`
      SELECT t.*, u.username as created_by_username
      FROM agent_templates t
      LEFT JOIN users u ON t.created_by = u.id
      WHERE t.is_default = 1
    `).get();

    return template ? this._format(template) : null;
  }

  // Update a template
  update(id, data, userId) {
    const db = getDb();
    const existing = this.findById(id);

    if (!existing) {
      return { error: "NOT_FOUND", message: "Template not found" };
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
    if (data.role !== undefined) {
      updates.push("role = ?");
      params.push(data.role);
    }
    if (data.default_metadata !== undefined) {
      updates.push("default_metadata = ?");
      params.push(JSON.stringify(data.default_metadata));
    }
    if (data.config !== undefined) {
      updates.push("config = ?");
      params.push(JSON.stringify(data.config));
    }
    if (data.tags !== undefined) {
      updates.push("tags = ?");
      params.push(JSON.stringify(data.tags));
    }
    if (data.groups !== undefined) {
      updates.push("groups = ?");
      params.push(JSON.stringify(data.groups));
    }
    if (data.is_default !== undefined) {
      if (data.is_default) {
        db.prepare("UPDATE agent_templates SET is_default = 0").run();
      }
      updates.push("is_default = ?");
      params.push(data.is_default ? 1 : 0);
    }

    if (updates.length === 0) {
      return { data: existing };
    }

    updates.push("updated_at = datetime('now')");
    params.push(id);

    try {
      db.prepare(`UPDATE agent_templates SET ${updates.join(", ")} WHERE id = ?`).run(...params);

      const updated = this.findById(id);

      // Create new version
      const latestVersion = this._getLatestVersion(id);
      this._createVersion(id, (latestVersion?.version || 0) + 1, updated, userId, data.change_notes || "Updated");

      webhookService.trigger("template.updated", { template: updated, previous: existing });
      return { data: updated, oldValue: existing };
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { error: "CONFLICT", message: "Template name already exists" };
      }
      throw err;
    }
  }

  // Delete a template
  delete(id) {
    const db = getDb();
    const existing = this.findById(id);

    if (!existing) {
      return { error: "NOT_FOUND", message: "Template not found" };
    }

    db.prepare("DELETE FROM agent_templates WHERE id = ?").run(id);
    webhookService.trigger("template.deleted", { template: existing });
    return { data: existing };
  }

  // Apply template to create an agent
  apply(templateId, agentData, _userId) {
    const db = getDb();
    const template = this.findById(templateId);

    if (!template) {
      return { error: "NOT_FOUND", message: "Template not found" };
    }

    // Merge template defaults with provided data
    const mergedData = {
      role: agentData.role || template.role,
      metadata: { ...template.defaultMetadata, ...(agentData.metadata || {}) },
      config: { ...template.config, ...(agentData.config || {}) },
    };

    // Increment usage count
    db.prepare("UPDATE agent_templates SET usage_count = usage_count + 1 WHERE id = ?").run(templateId);

    return {
      data: {
        ...mergedData,
        templateId,
        templateName: template.name,
        autoTags: template.tags,
        autoGroups: template.groups,
      },
    };
  }

  // Clone a template
  clone(id, newName, userId) {
    const template = this.findById(id);

    if (!template) {
      return { error: "NOT_FOUND", message: "Template not found" };
    }

    return this.create({
      name: newName,
      description: `Cloned from ${template.name}`,
      role: template.role,
      default_metadata: template.defaultMetadata,
      config: template.config,
      tags: template.tags,
      groups: template.groups,
    }, userId);
  }

  // Get template versions
  getVersions(templateId) {
    const db = getDb();
    const versions = db.prepare(`
      SELECT v.*, u.username as created_by_username
      FROM template_versions v
      LEFT JOIN users u ON v.created_by = u.id
      WHERE v.template_id = ?
      ORDER BY v.version DESC
    `).all(templateId);

    return versions.map((v) => ({
      id: v.id,
      templateId: v.template_id,
      version: v.version,
      role: v.role,
      defaultMetadata: JSON.parse(v.default_metadata || "{}"),
      config: JSON.parse(v.config || "{}"),
      tags: JSON.parse(v.tags || "[]"),
      groups: JSON.parse(v.groups || "[]"),
      changeNotes: v.change_notes,
      createdBy: v.created_by,
      createdByUsername: v.created_by_username,
      createdAt: v.created_at,
    }));
  }

  // Restore a specific version
  restoreVersion(templateId, version, userId) {
    const db = getDb();
    const versionData = db.prepare(`
      SELECT * FROM template_versions
      WHERE template_id = ? AND version = ?
    `).get(templateId, version);

    if (!versionData) {
      return { error: "NOT_FOUND", message: "Version not found" };
    }

    return this.update(templateId, {
      role: versionData.role,
      default_metadata: JSON.parse(versionData.default_metadata || "{}"),
      config: JSON.parse(versionData.config || "{}"),
      tags: JSON.parse(versionData.tags || "[]"),
      groups: JSON.parse(versionData.groups || "[]"),
      change_notes: `Restored from version ${version}`,
    }, userId);
  }

  _createVersion(templateId, version, data, userId, changeNotes) {
    const db = getDb();
    db.prepare(`
      INSERT INTO template_versions (template_id, version, role, default_metadata, config, tags, groups, change_notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      templateId,
      version,
      data.role,
      JSON.stringify(data.defaultMetadata || data.default_metadata || {}),
      JSON.stringify(data.config || {}),
      JSON.stringify(data.tags || []),
      JSON.stringify(data.groups || []),
      changeNotes,
      userId
    );
  }

  _getLatestVersion(templateId) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM template_versions
      WHERE template_id = ?
      ORDER BY version DESC
      LIMIT 1
    `).get(templateId);
  }

  _format(row) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      role: row.role,
      defaultMetadata: JSON.parse(row.default_metadata || "{}"),
      config: JSON.parse(row.config || "{}"),
      tags: JSON.parse(row.tags || "[]"),
      groups: JSON.parse(row.groups || "[]"),
      isDefault: Boolean(row.is_default),
      usageCount: row.usage_count,
      createdBy: row.created_by,
      createdByUsername: row.created_by_username,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = new TemplateService();
