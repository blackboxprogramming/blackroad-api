const { getDb } = require("../db");
const { logger } = require("../middleware/logger");
const agentControlService = require("./agent-control.service");
const webhookService = require("./webhook.service");

class SchedulerService {
  constructor() {
    this.timers = new Map(); // scheduledJobId -> timer
    this.checkInterval = null;
  }

  // Initialize scheduler tables
  initTable() {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
        group_id INTEGER REFERENCES agent_groups(id) ON DELETE CASCADE,
        command TEXT NOT NULL,
        payload TEXT DEFAULT '{}',
        schedule_type TEXT NOT NULL,
        cron_expression TEXT,
        run_at TEXT,
        repeat_interval INTEGER,
        max_runs INTEGER,
        run_count INTEGER DEFAULT 0,
        last_run_at TEXT,
        next_run_at TEXT,
        enabled INTEGER DEFAULT 1,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        CHECK (schedule_type IN ('once', 'interval', 'cron'))
      );

      CREATE TABLE IF NOT EXISTS scheduled_command_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scheduled_command_id INTEGER REFERENCES scheduled_commands(id) ON DELETE CASCADE,
        agent_id TEXT,
        command_id INTEGER REFERENCES agent_commands(id),
        status TEXT DEFAULT 'pending',
        result TEXT,
        started_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_commands_next_run ON scheduled_commands(next_run_at);
      CREATE INDEX IF NOT EXISTS idx_scheduled_commands_enabled ON scheduled_commands(enabled);
      CREATE INDEX IF NOT EXISTS idx_scheduled_runs_command ON scheduled_command_runs(scheduled_command_id);
    `);
  }

  // Start the scheduler
  start() {
    if (this.checkInterval) return;

    // Check for due commands every 10 seconds
    this.checkInterval = setInterval(() => {
      this._processDueCommands();
    }, 10000);

    logger.info("Scheduler started");
  }

  // Stop the scheduler
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    logger.info("Scheduler stopped");
  }

  // Create a scheduled command
  create(data, userId) {
    const db = getDb();
    const {
      name,
      agentId,
      groupId,
      command,
      payload = {},
      scheduleType,
      cronExpression,
      runAt,
      repeatInterval,
      maxRuns,
    } = data;

    // Validate schedule type
    if (!["once", "interval", "cron"].includes(scheduleType)) {
      return { error: "INVALID", message: "Invalid schedule type" };
    }

    // Calculate next run time
    let nextRunAt;
    if (scheduleType === "once" && runAt) {
      nextRunAt = new Date(runAt).toISOString();
    } else if (scheduleType === "interval" && repeatInterval) {
      nextRunAt = new Date(Date.now() + repeatInterval * 1000).toISOString();
    } else if (scheduleType === "cron" && cronExpression) {
      nextRunAt = this._getNextCronRun(cronExpression);
    } else {
      return { error: "INVALID", message: "Missing schedule configuration" };
    }

    const stmt = db.prepare(`
      INSERT INTO scheduled_commands
      (name, agent_id, group_id, command, payload, schedule_type, cron_expression, run_at, repeat_interval, max_runs, next_run_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      name,
      agentId || null,
      groupId || null,
      command,
      JSON.stringify(payload),
      scheduleType,
      cronExpression || null,
      runAt || null,
      repeatInterval || null,
      maxRuns || null,
      nextRunAt,
      userId
    );

    const scheduled = this.findById(result.lastInsertRowid);
    logger.info({ scheduledId: scheduled.id, name, nextRunAt }, "Scheduled command created");

    return { data: scheduled };
  }

  // Find all scheduled commands
  findAll({ page = 1, limit = 50, enabled } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;

    let query = "SELECT * FROM scheduled_commands WHERE 1=1";
    const params = [];

    if (enabled !== undefined) {
      query += " AND enabled = ?";
      params.push(enabled ? 1 : 0);
    }

    const total = db.prepare(query.replace("*", "COUNT(*) as count")).get(...params).count;

    query += " ORDER BY next_run_at ASC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const scheduled = db.prepare(query).all(...params);

    return {
      data: scheduled.map(this._format),
      pagination: { page, limit, total },
    };
  }

  // Find by ID
  findById(id) {
    const db = getDb();
    const scheduled = db.prepare("SELECT * FROM scheduled_commands WHERE id = ?").get(id);
    return scheduled ? this._format(scheduled) : null;
  }

  // Update scheduled command
  update(id, data) {
    const db = getDb();
    const existing = this.findById(id);
    if (!existing) {
      return { error: "NOT_FOUND", message: "Scheduled command not found" };
    }

    const updates = [];
    const params = [];

    const allowedFields = ["name", "command", "payload", "repeatInterval", "maxRuns", "enabled"];
    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        const dbField = field.replace(/([A-Z])/g, "_$1").toLowerCase();
        updates.push(`${dbField} = ?`);
        params.push(field === "payload" ? JSON.stringify(data[field]) : data[field]);
      }
    }

    if (updates.length === 0) {
      return { data: existing };
    }

    updates.push("updated_at = datetime('now')");
    params.push(id);

    db.prepare(`UPDATE scheduled_commands SET ${updates.join(", ")} WHERE id = ?`).run(...params);

    return { data: this.findById(id), oldValue: existing };
  }

  // Delete scheduled command
  delete(id) {
    const db = getDb();
    const existing = this.findById(id);
    if (!existing) {
      return { error: "NOT_FOUND", message: "Scheduled command not found" };
    }

    db.prepare("DELETE FROM scheduled_commands WHERE id = ?").run(id);
    return { data: existing };
  }

  // Enable/disable scheduled command
  setEnabled(id, enabled) {
    const db = getDb();
    const result = db.prepare("UPDATE scheduled_commands SET enabled = ?, updated_at = datetime('now') WHERE id = ?")
      .run(enabled ? 1 : 0, id);

    if (result.changes === 0) {
      return { error: "NOT_FOUND", message: "Scheduled command not found" };
    }

    return { data: this.findById(id) };
  }

  // Get run history
  getRunHistory(scheduledId, { page = 1, limit = 20 } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;

    const total = db.prepare("SELECT COUNT(*) as count FROM scheduled_command_runs WHERE scheduled_command_id = ?")
      .get(scheduledId).count;

    const runs = db.prepare(`
      SELECT * FROM scheduled_command_runs
      WHERE scheduled_command_id = ?
      ORDER BY started_at DESC
      LIMIT ? OFFSET ?
    `).all(scheduledId, limit, offset);

    return {
      data: runs.map((r) => ({
        id: r.id,
        agentId: r.agent_id,
        commandId: r.command_id,
        status: r.status,
        result: r.result ? JSON.parse(r.result) : null,
        startedAt: r.started_at,
        completedAt: r.completed_at,
      })),
      pagination: { page, limit, total },
    };
  }

  // Process due commands
  _processDueCommands() {
    const db = getDb();
    const now = new Date().toISOString();

    const dueCommands = db.prepare(`
      SELECT * FROM scheduled_commands
      WHERE enabled = 1 AND next_run_at <= ?
      AND (max_runs IS NULL OR run_count < max_runs)
    `).all(now);

    for (const scheduled of dueCommands) {
      this._executeScheduledCommand(scheduled);
    }
  }

  // Execute a scheduled command
  async _executeScheduledCommand(scheduled) {
    const db = getDb();

    logger.info({ scheduledId: scheduled.id, name: scheduled.name }, "Executing scheduled command");

    // Get target agents
    let agents = [];
    if (scheduled.agent_id) {
      agents = [{ id: scheduled.agent_id }];
    } else if (scheduled.group_id) {
      agents = db.prepare(`
        SELECT agent_id as id FROM agent_group_members WHERE group_id = ?
      `).all(scheduled.group_id);
    }

    const payload = JSON.parse(scheduled.payload || "{}");

    // Execute command for each agent
    for (const agent of agents) {
      const runId = db.prepare(`
        INSERT INTO scheduled_command_runs (scheduled_command_id, agent_id, status)
        VALUES (?, ?, 'running')
      `).run(scheduled.id, agent.id).lastInsertRowid;

      try {
        const result = agentControlService.issueCommand(
          agent.id,
          scheduled.command,
          payload,
          scheduled.created_by
        );

        db.prepare(`
          UPDATE scheduled_command_runs
          SET status = ?, command_id = ?, result = ?, completed_at = datetime('now')
          WHERE id = ?
        `).run(
          result.error ? "failed" : "completed",
          result.data?.id || null,
          JSON.stringify(result),
          runId
        );
      } catch (err) {
        db.prepare(`
          UPDATE scheduled_command_runs
          SET status = 'failed', result = ?, completed_at = datetime('now')
          WHERE id = ?
        `).run(JSON.stringify({ error: err.message }), runId);
      }
    }

    // Update scheduled command
    const nextRunAt = this._calculateNextRun(scheduled);

    db.prepare(`
      UPDATE scheduled_commands
      SET run_count = run_count + 1, last_run_at = datetime('now'), next_run_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(nextRunAt, scheduled.id);

    // Disable if max runs reached or one-time
    if (scheduled.schedule_type === "once" ||
        (scheduled.max_runs && scheduled.run_count + 1 >= scheduled.max_runs)) {
      db.prepare("UPDATE scheduled_commands SET enabled = 0 WHERE id = ?").run(scheduled.id);
    }

    webhookService.trigger("scheduled.executed", {
      scheduledCommand: this._format(scheduled),
      executedAgents: agents.length,
    });
  }

  // Calculate next run time
  _calculateNextRun(scheduled) {
    if (scheduled.schedule_type === "once") {
      return null;
    }

    if (scheduled.schedule_type === "interval" && scheduled.repeat_interval) {
      return new Date(Date.now() + scheduled.repeat_interval * 1000).toISOString();
    }

    if (scheduled.schedule_type === "cron" && scheduled.cron_expression) {
      return this._getNextCronRun(scheduled.cron_expression);
    }

    return null;
  }

  // Simple cron parser (minute hour day month weekday)
  _getNextCronRun(cronExpression) {
    // For simplicity, just add 1 minute for now
    // In production, use a proper cron parser like 'cron-parser'
    const parts = cronExpression.split(" ");
    if (parts.length !== 5) {
      return new Date(Date.now() + 60000).toISOString();
    }

    // Basic implementation: just use interval for common patterns
    const [minute, hour] = parts;

    const now = new Date();
    const next = new Date(now);

    if (minute === "*" && hour === "*") {
      // Every minute
      next.setMinutes(next.getMinutes() + 1);
    } else if (minute !== "*" && hour === "*") {
      // Every hour at specific minute
      next.setMinutes(parseInt(minute));
      if (next <= now) {
        next.setHours(next.getHours() + 1);
      }
    } else if (minute !== "*" && hour !== "*") {
      // Specific time daily
      next.setHours(parseInt(hour), parseInt(minute), 0, 0);
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }
    } else {
      // Default: 1 hour from now
      next.setHours(next.getHours() + 1);
    }

    return next.toISOString();
  }

  _format(row) {
    return {
      id: row.id,
      name: row.name,
      agentId: row.agent_id,
      groupId: row.group_id,
      command: row.command,
      payload: JSON.parse(row.payload || "{}"),
      scheduleType: row.schedule_type,
      cronExpression: row.cron_expression,
      runAt: row.run_at,
      repeatInterval: row.repeat_interval,
      maxRuns: row.max_runs,
      runCount: row.run_count,
      lastRunAt: row.last_run_at,
      nextRunAt: row.next_run_at,
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = new SchedulerService();
