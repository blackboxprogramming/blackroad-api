const { getDb } = require("../db");
const agentControlService = require("./agent-control.service");
const websocketService = require("./websocket.service");
const webhookService = require("./webhook.service");

class BulkService {
  initTable() {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS bulk_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL, -- 'command', 'update', 'delete', 'tag', 'group'
        status TEXT DEFAULT 'pending', -- 'pending', 'running', 'completed', 'failed', 'cancelled'
        target_type TEXT NOT NULL, -- 'agents', 'groups', 'tags'
        target_ids TEXT NOT NULL, -- JSON array of IDs
        operation_data TEXT, -- JSON with operation details
        total_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        results TEXT, -- JSON array of results
        error_message TEXT,
        created_by INTEGER REFERENCES users(id),
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_bulk_ops_status ON bulk_operations(status);
      CREATE INDEX IF NOT EXISTS idx_bulk_ops_created_by ON bulk_operations(created_by);
    `);
  }

  // Create a bulk operation
  create(data, userId) {
    const db = getDb();
    const { type, target_type, target_ids, operation_data = {} } = data;

    const result = db.prepare(`
      INSERT INTO bulk_operations (type, target_type, target_ids, operation_data, total_count, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(type, target_type, JSON.stringify(target_ids), JSON.stringify(operation_data), target_ids.length, userId);

    const operation = this.findById(result.lastInsertRowid);

    // Start processing immediately for small batches
    if (target_ids.length <= 10) {
      this._process(operation);
    }

    return { data: operation };
  }

  // Find operation by ID
  findById(id) {
    const db = getDb();
    const op = db.prepare("SELECT * FROM bulk_operations WHERE id = ?").get(id);
    return op ? this._format(op) : null;
  }

  // Find all operations
  findAll({ page = 1, limit = 50, status, type, userId } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;
    const conditions = [];
    const params = [];

    if (status) {
      conditions.push("status = ?");
      params.push(status);
    }
    if (type) {
      conditions.push("type = ?");
      params.push(type);
    }
    if (userId) {
      conditions.push("created_by = ?");
      params.push(userId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const total = db.prepare(`SELECT COUNT(*) as count FROM bulk_operations ${where}`).get(...params).count;

    const operations = db.prepare(`
      SELECT bo.*, u.username as created_by_username
      FROM bulk_operations bo
      LEFT JOIN users u ON bo.created_by = u.id
      ${where}
      ORDER BY bo.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return {
      data: operations.map(this._format),
      pagination: { page, limit, total },
    };
  }

  // Process a bulk operation
  async _process(operation) {
    const db = getDb();
    const targetIds = operation.targetIds;
    const results = [];
    let successCount = 0;
    let failedCount = 0;

    // Update status to running
    db.prepare("UPDATE bulk_operations SET status = 'running', started_at = datetime('now') WHERE id = ?")
      .run(operation.id);

    websocketService.broadcast("bulk:progress", {
      operationId: operation.id,
      status: "running",
      progress: 0,
    });

    for (let i = 0; i < targetIds.length; i++) {
      const targetId = targetIds[i];
      let result;

      try {
        switch (operation.type) {
          case "command":
            result = await this._executeCommand(targetId, operation.operationData);
            break;
          case "update":
            result = this._executeUpdate(targetId, operation.operationData);
            break;
          case "delete":
            result = this._executeDelete(targetId, operation.targetType);
            break;
          case "tag":
            result = this._executeTag(targetId, operation.operationData);
            break;
          case "group":
            result = this._executeGroup(targetId, operation.operationData);
            break;
          default:
            result = { success: false, error: "Unknown operation type" };
        }

        if (result.success) {
          successCount++;
        } else {
          failedCount++;
        }
        results.push({ targetId, ...result });
      } catch (err) {
        failedCount++;
        results.push({ targetId, success: false, error: err.message });
      }

      // Broadcast progress
      const progress = Math.round(((i + 1) / targetIds.length) * 100);
      websocketService.broadcast("bulk:progress", {
        operationId: operation.id,
        status: "running",
        progress,
        successCount,
        failedCount,
      });
    }

    // Update operation with results
    const finalStatus = failedCount === targetIds.length ? "failed" : "completed";
    db.prepare(`
      UPDATE bulk_operations
      SET status = ?, success_count = ?, failed_count = ?, results = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(finalStatus, successCount, failedCount, JSON.stringify(results), operation.id);

    webhookService.trigger("bulk.completed", {
      operation: this.findById(operation.id),
    });

    return { successCount, failedCount, results };
  }

  _executeCommand(agentId, data) {
    const { command, payload = {} } = data;
    const result = agentControlService.sendCommand(agentId, command, payload, data.userId);

    if (result.error) {
      return { success: false, error: result.message };
    }
    return { success: true, commandId: result.data.id };
  }

  _executeUpdate(agentId, data) {
    const db = getDb();
    const { updates } = data;

    try {
      const updateClauses = [];
      const params = [];

      if (updates.role !== undefined) {
        updateClauses.push("role = ?");
        params.push(updates.role);
      }
      if (updates.active !== undefined) {
        updateClauses.push("active = ?");
        params.push(updates.active ? 1 : 0);
      }
      if (updates.metadata !== undefined) {
        updateClauses.push("metadata = ?");
        params.push(JSON.stringify(updates.metadata));
      }

      if (updateClauses.length === 0) {
        return { success: true, message: "No updates provided" };
      }

      updateClauses.push("updated_at = datetime('now')");
      params.push(agentId);

      const result = db.prepare(`UPDATE agents SET ${updateClauses.join(", ")} WHERE id = ?`).run(...params);

      if (result.changes === 0) {
        return { success: false, error: "Agent not found" };
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  _executeDelete(targetId, targetType) {
    const db = getDb();
    let table;

    switch (targetType) {
      case "agents":
        table = "agents";
        break;
      case "groups":
        table = "agent_groups";
        break;
      case "tags":
        table = "agent_tags";
        break;
      default:
        return { success: false, error: "Unknown target type" };
    }

    const result = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(targetId);

    if (result.changes === 0) {
      return { success: false, error: "Not found" };
    }

    return { success: true };
  }

  _executeTag(agentId, data) {
    const db = getDb();
    const { action, tagId } = data;

    try {
      if (action === "add") {
        db.prepare("INSERT INTO agent_tag_assignments (tag_id, agent_id) VALUES (?, ?)")
          .run(tagId, agentId);
      } else if (action === "remove") {
        db.prepare("DELETE FROM agent_tag_assignments WHERE tag_id = ? AND agent_id = ?")
          .run(tagId, agentId);
      }
      return { success: true };
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        return { success: true, message: "Already assigned" };
      }
      return { success: false, error: err.message };
    }
  }

  _executeGroup(agentId, data) {
    const db = getDb();
    const { action, groupId, userId } = data;

    try {
      if (action === "add") {
        db.prepare("INSERT INTO agent_group_members (group_id, agent_id, added_by) VALUES (?, ?, ?)")
          .run(groupId, agentId, userId);
      } else if (action === "remove") {
        db.prepare("DELETE FROM agent_group_members WHERE group_id = ? AND agent_id = ?")
          .run(groupId, agentId);
      }
      return { success: true };
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        return { success: true, message: "Already in group" };
      }
      return { success: false, error: err.message };
    }
  }

  // Manually trigger processing of a pending operation
  process(id) {
    const operation = this.findById(id);

    if (!operation) {
      return { error: "NOT_FOUND", message: "Operation not found" };
    }

    if (operation.status !== "pending") {
      return { error: "INVALID_STATE", message: `Operation is ${operation.status}` };
    }

    this._process(operation);
    return { data: { id, processing: true } };
  }

  // Cancel a pending operation
  cancel(id) {
    const db = getDb();
    const operation = this.findById(id);

    if (!operation) {
      return { error: "NOT_FOUND", message: "Operation not found" };
    }

    if (operation.status !== "pending") {
      return { error: "INVALID_STATE", message: `Cannot cancel ${operation.status} operation` };
    }

    db.prepare("UPDATE bulk_operations SET status = 'cancelled' WHERE id = ?").run(id);
    return { data: { id, cancelled: true } };
  }

  // Retry failed items in an operation
  retry(id, userId) {
    const operation = this.findById(id);

    if (!operation) {
      return { error: "NOT_FOUND", message: "Operation not found" };
    }

    if (operation.status !== "completed" && operation.status !== "failed") {
      return { error: "INVALID_STATE", message: "Can only retry completed or failed operations" };
    }

    const failedItems = operation.results.filter((r) => !r.success).map((r) => r.targetId);

    if (failedItems.length === 0) {
      return { error: "NO_FAILURES", message: "No failed items to retry" };
    }

    // Create new operation with only failed items
    return this.create({
      type: operation.type,
      target_type: operation.targetType,
      target_ids: failedItems,
      operation_data: operation.operationData,
    }, userId);
  }

  _format(row) {
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      targetType: row.target_type,
      targetIds: JSON.parse(row.target_ids || "[]"),
      operationData: JSON.parse(row.operation_data || "{}"),
      totalCount: row.total_count,
      successCount: row.success_count,
      failedCount: row.failed_count,
      results: JSON.parse(row.results || "[]"),
      errorMessage: row.error_message,
      createdBy: row.created_by,
      createdByUsername: row.created_by_username,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
    };
  }
}

module.exports = new BulkService();
