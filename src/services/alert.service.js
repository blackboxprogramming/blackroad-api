const { getDb } = require("../db");
const websocketService = require("./websocket.service");
const webhookService = require("./webhook.service");

class AlertService {
  constructor() {
    this.checkInterval = null;
    this.alertHandlers = new Map();
  }

  initTable() {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS alert_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        condition_type TEXT NOT NULL, -- 'threshold', 'absence', 'pattern', 'comparison'
        metric TEXT NOT NULL, -- What to monitor
        operator TEXT, -- '>', '<', '>=', '<=', '==', '!='
        threshold REAL,
        duration_seconds INTEGER DEFAULT 60, -- How long condition must be true
        severity TEXT DEFAULT 'warning', -- 'info', 'warning', 'error', 'critical'
        enabled INTEGER DEFAULT 1,
        notify_channels TEXT DEFAULT '["websocket"]', -- JSON array
        cooldown_seconds INTEGER DEFAULT 300, -- Minimum time between alerts
        last_triggered_at TEXT,
        trigger_count INTEGER DEFAULT 0,
        config TEXT DEFAULT '{}', -- Additional configuration
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS alert_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER REFERENCES alert_rules(id) ON DELETE CASCADE,
        severity TEXT NOT NULL,
        status TEXT DEFAULT 'active', -- 'active', 'acknowledged', 'resolved'
        metric_value REAL,
        message TEXT,
        context TEXT DEFAULT '{}',
        acknowledged_by INTEGER REFERENCES users(id),
        acknowledged_at TEXT,
        resolved_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS alert_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        rule_id INTEGER REFERENCES alert_rules(id) ON DELETE CASCADE,
        channel TEXT DEFAULT 'websocket', -- 'websocket', 'webhook', 'email'
        config TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, rule_id, channel)
      );

      CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled);
      CREATE INDEX IF NOT EXISTS idx_alert_events_rule ON alert_events(rule_id);
      CREATE INDEX IF NOT EXISTS idx_alert_events_status ON alert_events(status);
      CREATE INDEX IF NOT EXISTS idx_alert_subscriptions_user ON alert_subscriptions(user_id);
    `);
  }

  // Create an alert rule
  createRule(data, userId) {
    const db = getDb();
    const {
      name,
      description,
      condition_type,
      metric,
      operator,
      threshold,
      duration_seconds = 60,
      severity = "warning",
      notify_channels = ["websocket"],
      cooldown_seconds = 300,
      config = {},
    } = data;

    try {
      const result = db.prepare(`
        INSERT INTO alert_rules (name, description, condition_type, metric, operator, threshold, duration_seconds, severity, notify_channels, cooldown_seconds, config, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        name,
        description || null,
        condition_type,
        metric,
        operator || null,
        threshold || null,
        duration_seconds,
        severity,
        JSON.stringify(notify_channels),
        cooldown_seconds,
        JSON.stringify(config),
        userId
      );

      const rule = this.findRuleById(result.lastInsertRowid);
      webhookService.trigger("alert.rule_created", { rule });
      return { data: rule };
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { error: "CONFLICT", message: "Alert rule name already exists" };
      }
      throw err;
    }
  }

  // Find rule by ID
  findRuleById(id) {
    const db = getDb();
    const rule = db.prepare(`
      SELECT r.*, u.username as created_by_username,
        (SELECT COUNT(*) FROM alert_events WHERE rule_id = r.id) as event_count,
        (SELECT COUNT(*) FROM alert_events WHERE rule_id = r.id AND status = 'active') as active_count
      FROM alert_rules r
      LEFT JOIN users u ON r.created_by = u.id
      WHERE r.id = ?
    `).get(id);

    return rule ? this._formatRule(rule) : null;
  }

  // Find all rules
  findAllRules({ page = 1, limit = 50, enabled, severity } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;
    const conditions = [];
    const params = [];

    if (enabled !== undefined) {
      conditions.push("r.enabled = ?");
      params.push(enabled ? 1 : 0);
    }
    if (severity) {
      conditions.push("r.severity = ?");
      params.push(severity);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const total = db.prepare(`SELECT COUNT(*) as count FROM alert_rules r ${where}`).get(...params).count;

    const rules = db.prepare(`
      SELECT r.*, u.username as created_by_username,
        (SELECT COUNT(*) FROM alert_events WHERE rule_id = r.id) as event_count,
        (SELECT COUNT(*) FROM alert_events WHERE rule_id = r.id AND status = 'active') as active_count
      FROM alert_rules r
      LEFT JOIN users u ON r.created_by = u.id
      ${where}
      ORDER BY r.severity DESC, r.name ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return {
      data: rules.map(this._formatRule),
      pagination: { page, limit, total },
    };
  }

  // Update rule
  updateRule(id, data) {
    const db = getDb();
    const existing = this.findRuleById(id);

    if (!existing) {
      return { error: "NOT_FOUND", message: "Alert rule not found" };
    }

    const updates = [];
    const params = [];

    const fields = ["name", "description", "condition_type", "metric", "operator", "threshold", "duration_seconds", "severity", "cooldown_seconds"];
    for (const field of fields) {
      if (data[field] !== undefined) {
        updates.push(`${field} = ?`);
        params.push(data[field]);
      }
    }

    if (data.enabled !== undefined) {
      updates.push("enabled = ?");
      params.push(data.enabled ? 1 : 0);
    }
    if (data.notify_channels !== undefined) {
      updates.push("notify_channels = ?");
      params.push(JSON.stringify(data.notify_channels));
    }
    if (data.config !== undefined) {
      updates.push("config = ?");
      params.push(JSON.stringify(data.config));
    }

    if (updates.length === 0) {
      return { data: existing };
    }

    updates.push("updated_at = datetime('now')");
    params.push(id);

    try {
      db.prepare(`UPDATE alert_rules SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      return { data: this.findRuleById(id), oldValue: existing };
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { error: "CONFLICT", message: "Alert rule name already exists" };
      }
      throw err;
    }
  }

  // Delete rule
  deleteRule(id) {
    const db = getDb();
    const existing = this.findRuleById(id);

    if (!existing) {
      return { error: "NOT_FOUND", message: "Alert rule not found" };
    }

    db.prepare("DELETE FROM alert_rules WHERE id = ?").run(id);
    return { data: existing };
  }

  // Trigger an alert
  trigger(ruleId, { value, message, context = {} } = {}) {
    const db = getDb();
    const rule = this.findRuleById(ruleId);

    if (!rule || !rule.enabled) {
      return { error: "INVALID", message: "Rule not found or disabled" };
    }

    // Check cooldown
    if (rule.lastTriggeredAt) {
      const lastTriggered = new Date(rule.lastTriggeredAt);
      const cooldownEnd = new Date(lastTriggered.getTime() + rule.cooldownSeconds * 1000);
      if (new Date() < cooldownEnd) {
        return { error: "COOLDOWN", message: "Alert is in cooldown period" };
      }
    }

    // Create alert event
    const result = db.prepare(`
      INSERT INTO alert_events (rule_id, severity, metric_value, message, context)
      VALUES (?, ?, ?, ?, ?)
    `).run(ruleId, rule.severity, value || null, message || rule.name, JSON.stringify(context));

    // Update rule
    db.prepare(`
      UPDATE alert_rules
      SET last_triggered_at = datetime('now'), trigger_count = trigger_count + 1
      WHERE id = ?
    `).run(ruleId);

    const event = this.getEvent(result.lastInsertRowid);

    // Send notifications
    this._notify(rule, event);

    return { data: event };
  }

  // Manually create an alert event
  createEvent(data) {
    const db = getDb();
    const { rule_id, severity = "warning", message, context = {} } = data;

    const result = db.prepare(`
      INSERT INTO alert_events (rule_id, severity, message, context)
      VALUES (?, ?, ?, ?)
    `).run(rule_id || null, severity, message, JSON.stringify(context));

    const event = this.getEvent(result.lastInsertRowid);

    // Broadcast to all alert subscribers
    websocketService.broadcast("alerts", {
      type: "new_alert",
      event,
    });

    return { data: event };
  }

  // Get event by ID
  getEvent(id) {
    const db = getDb();
    const event = db.prepare(`
      SELECT e.*, r.name as rule_name, u.username as acknowledged_by_username
      FROM alert_events e
      LEFT JOIN alert_rules r ON e.rule_id = r.id
      LEFT JOIN users u ON e.acknowledged_by = u.id
      WHERE e.id = ?
    `).get(id);

    return event ? this._formatEvent(event) : null;
  }

  // Get all events
  getEvents({ page = 1, limit = 50, status, severity, rule_id } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;
    const conditions = [];
    const params = [];

    if (status) {
      conditions.push("e.status = ?");
      params.push(status);
    }
    if (severity) {
      conditions.push("e.severity = ?");
      params.push(severity);
    }
    if (rule_id) {
      conditions.push("e.rule_id = ?");
      params.push(rule_id);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const total = db.prepare(`SELECT COUNT(*) as count FROM alert_events e ${where}`).get(...params).count;

    const events = db.prepare(`
      SELECT e.*, r.name as rule_name, u.username as acknowledged_by_username
      FROM alert_events e
      LEFT JOIN alert_rules r ON e.rule_id = r.id
      LEFT JOIN users u ON e.acknowledged_by = u.id
      ${where}
      ORDER BY e.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return {
      data: events.map(this._formatEvent),
      pagination: { page, limit, total },
    };
  }

  // Acknowledge an alert
  acknowledge(eventId, userId) {
    const db = getDb();
    const event = this.getEvent(eventId);

    if (!event) {
      return { error: "NOT_FOUND", message: "Alert event not found" };
    }

    if (event.status !== "active") {
      return { error: "INVALID_STATE", message: `Cannot acknowledge ${event.status} alert` };
    }

    db.prepare(`
      UPDATE alert_events
      SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = datetime('now')
      WHERE id = ?
    `).run(userId, eventId);

    websocketService.broadcast("alerts", {
      type: "acknowledged",
      eventId,
    });

    return { data: this.getEvent(eventId) };
  }

  // Resolve an alert
  resolve(eventId, userId) {
    const db = getDb();
    const event = this.getEvent(eventId);

    if (!event) {
      return { error: "NOT_FOUND", message: "Alert event not found" };
    }

    if (event.status === "resolved") {
      return { error: "INVALID_STATE", message: "Alert already resolved" };
    }

    db.prepare(`
      UPDATE alert_events
      SET status = 'resolved', resolved_at = datetime('now'),
          acknowledged_by = COALESCE(acknowledged_by, ?),
          acknowledged_at = COALESCE(acknowledged_at, datetime('now'))
      WHERE id = ?
    `).run(userId, eventId);

    websocketService.broadcast("alerts", {
      type: "resolved",
      eventId,
    });

    return { data: this.getEvent(eventId) };
  }

  // Subscribe to alerts
  subscribe(userId, ruleId, channel = "websocket", config = {}) {
    const db = getDb();

    try {
      db.prepare(`
        INSERT INTO alert_subscriptions (user_id, rule_id, channel, config)
        VALUES (?, ?, ?, ?)
      `).run(userId, ruleId, channel, JSON.stringify(config));

      return { data: { userId, ruleId, channel, subscribed: true } };
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { error: "CONFLICT", message: "Already subscribed" };
      }
      throw err;
    }
  }

  // Unsubscribe from alerts
  unsubscribe(userId, ruleId, channel) {
    const db = getDb();
    const result = db.prepare(`
      DELETE FROM alert_subscriptions
      WHERE user_id = ? AND rule_id = ? AND channel = ?
    `).run(userId, ruleId, channel);

    if (result.changes === 0) {
      return { error: "NOT_FOUND", message: "Subscription not found" };
    }

    return { data: { userId, ruleId, channel, unsubscribed: true } };
  }

  // Get user's subscriptions
  getUserSubscriptions(userId) {
    const db = getDb();
    return db.prepare(`
      SELECT s.*, r.name as rule_name, r.severity
      FROM alert_subscriptions s
      JOIN alert_rules r ON s.rule_id = r.id
      WHERE s.user_id = ?
      ORDER BY r.name
    `).all(userId).map((s) => ({
      id: s.id,
      ruleId: s.rule_id,
      ruleName: s.rule_name,
      severity: s.severity,
      channel: s.channel,
      config: JSON.parse(s.config || "{}"),
      createdAt: s.created_at,
    }));
  }

  // Get alert summary
  getSummary() {
    const db = getDb();

    const activeAlerts = db.prepare("SELECT COUNT(*) as count FROM alert_events WHERE status = 'active'").get().count;
    const acknowledgedAlerts = db.prepare("SELECT COUNT(*) as count FROM alert_events WHERE status = 'acknowledged'").get().count;
    const totalRules = db.prepare("SELECT COUNT(*) as count FROM alert_rules").get().count;
    const enabledRules = db.prepare("SELECT COUNT(*) as count FROM alert_rules WHERE enabled = 1").get().count;

    const bySeverity = db.prepare(`
      SELECT severity, COUNT(*) as count
      FROM alert_events
      WHERE status = 'active'
      GROUP BY severity
    `).all().reduce((acc, row) => {
      acc[row.severity] = row.count;
      return acc;
    }, {});

    const recentEvents = db.prepare(`
      SELECT e.*, r.name as rule_name
      FROM alert_events e
      LEFT JOIN alert_rules r ON e.rule_id = r.id
      ORDER BY e.created_at DESC
      LIMIT 10
    `).all().map(this._formatEvent);

    return {
      activeAlerts,
      acknowledgedAlerts,
      totalRules,
      enabledRules,
      bySeverity,
      recentEvents,
    };
  }

  // Send notifications for an alert
  _notify(rule, event) {
    for (const channel of rule.notifyChannels) {
      switch (channel) {
        case "websocket":
          websocketService.broadcast("alerts", {
            type: "new_alert",
            event,
            rule: { id: rule.id, name: rule.name, severity: rule.severity },
          });
          break;
        case "webhook":
          webhookService.trigger("alert.triggered", { rule, event });
          break;
      }
    }
  }

  _formatRule(row) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      conditionType: row.condition_type,
      metric: row.metric,
      operator: row.operator,
      threshold: row.threshold,
      durationSeconds: row.duration_seconds,
      severity: row.severity,
      enabled: Boolean(row.enabled),
      notifyChannels: JSON.parse(row.notify_channels || "[]"),
      cooldownSeconds: row.cooldown_seconds,
      lastTriggeredAt: row.last_triggered_at,
      triggerCount: row.trigger_count,
      eventCount: row.event_count || 0,
      activeCount: row.active_count || 0,
      config: JSON.parse(row.config || "{}"),
      createdBy: row.created_by,
      createdByUsername: row.created_by_username,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  _formatEvent(row) {
    return {
      id: row.id,
      ruleId: row.rule_id,
      ruleName: row.rule_name,
      severity: row.severity,
      status: row.status,
      metricValue: row.metric_value,
      message: row.message,
      context: JSON.parse(row.context || "{}"),
      acknowledgedBy: row.acknowledged_by,
      acknowledgedByUsername: row.acknowledged_by_username,
      acknowledgedAt: row.acknowledged_at,
      resolvedAt: row.resolved_at,
      createdAt: row.created_at,
    };
  }
}

module.exports = new AlertService();
