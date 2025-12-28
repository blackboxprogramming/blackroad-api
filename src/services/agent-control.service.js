const { getDb } = require("../db");
const { logger } = require("../middleware/logger");
const websocketService = require("./websocket.service");
const webhookService = require("./webhook.service");

class AgentControlService {
  constructor() {
    this.commandQueue = new Map(); // agentId -> pending commands
  }

  // Initialize control tables
  initTable() {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        command TEXT NOT NULL,
        payload TEXT DEFAULT '{}',
        status TEXT DEFAULT 'pending',
        result TEXT,
        issued_by INTEGER REFERENCES users(id),
        issued_at TEXT DEFAULT (datetime('now')),
        executed_at TEXT,
        expires_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_heartbeats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        status TEXT NOT NULL,
        metrics TEXT DEFAULT '{}',
        ip_address TEXT,
        version TEXT,
        received_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_agent_commands_agent ON agent_commands(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_commands_status ON agent_commands(status);
      CREATE INDEX IF NOT EXISTS idx_agent_heartbeats_agent ON agent_heartbeats(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_heartbeats_time ON agent_heartbeats(received_at);
    `);
  }

  // Issue command to agent
  issueCommand(agentId, command, payload = {}, userId = null, expiresInSeconds = 300) {
    const db = getDb();

    // Validate command
    const validCommands = ["start", "stop", "restart", "ping", "configure", "update", "status"];
    if (!validCommands.includes(command)) {
      return { error: "INVALID_COMMAND", message: `Invalid command. Valid: ${validCommands.join(", ")}` };
    }

    // Check agent exists
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
    if (!agent) {
      return { error: "NOT_FOUND", message: "Agent not found" };
    }

    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

    const stmt = db.prepare(`
      INSERT INTO agent_commands (agent_id, command, payload, issued_by, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(agentId, command, JSON.stringify(payload), userId, expiresAt);

    const commandData = {
      id: result.lastInsertRowid,
      agentId,
      command,
      payload,
      status: "pending",
      issuedAt: new Date().toISOString(),
      expiresAt,
    };

    // Notify via WebSocket
    websocketService.broadcast(`agents:${agentId}`, {
      type: "command",
      command: commandData,
    });

    // Trigger webhook
    webhookService.trigger("agent.command", { agent: { id: agentId }, command: commandData });

    logger.info({ agentId, command, commandId: commandData.id }, "Command issued to agent");

    return { data: commandData };
  }

  // Get pending commands for agent
  getPendingCommands(agentId) {
    const db = getDb();
    const now = new Date().toISOString();

    const commands = db.prepare(`
      SELECT * FROM agent_commands
      WHERE agent_id = ? AND status = 'pending' AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY issued_at ASC
    `).all(agentId, now);

    return commands.map(this._formatCommand);
  }

  // Acknowledge command (agent reports execution)
  acknowledgeCommand(commandId, result = null, success = true) {
    const db = getDb();

    const command = db.prepare("SELECT * FROM agent_commands WHERE id = ?").get(commandId);
    if (!command) {
      return { error: "NOT_FOUND", message: "Command not found" };
    }

    const status = success ? "completed" : "failed";

    db.prepare(`
      UPDATE agent_commands
      SET status = ?, result = ?, executed_at = datetime('now')
      WHERE id = ?
    `).run(status, JSON.stringify(result), commandId);

    const updatedCommand = this._formatCommand(db.prepare("SELECT * FROM agent_commands WHERE id = ?").get(commandId));

    // Notify via WebSocket
    websocketService.broadcast(`agents:${command.agent_id}`, {
      type: "command_result",
      command: updatedCommand,
    });

    // Trigger webhook
    webhookService.trigger("agent.command.completed", {
      agent: { id: command.agent_id },
      command: updatedCommand,
    });

    return { data: updatedCommand };
  }

  // Record heartbeat from agent
  recordHeartbeat(agentId, data) {
    const db = getDb();
    const { status = "healthy", metrics = {}, ipAddress, version } = data;

    // Validate agent exists
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
    if (!agent) {
      return { error: "NOT_FOUND", message: "Agent not found" };
    }

    // Insert heartbeat
    db.prepare(`
      INSERT INTO agent_heartbeats (agent_id, status, metrics, ip_address, version)
      VALUES (?, ?, ?, ?, ?)
    `).run(agentId, status, JSON.stringify(metrics), ipAddress, version);

    // Update agent active status based on health
    const isActive = status === "healthy" || status === "running";
    db.prepare("UPDATE agents SET active = ?, updated_at = datetime('now') WHERE id = ?")
      .run(isActive ? 1 : 0, agentId);

    // Notify via WebSocket
    websocketService.broadcast(`agents:${agentId}`, {
      type: "heartbeat",
      agentId,
      status,
      metrics,
      timestamp: new Date().toISOString(),
    });

    // Detect status changes and trigger webhooks
    const lastHeartbeat = db.prepare(`
      SELECT status FROM agent_heartbeats
      WHERE agent_id = ? AND id != (SELECT MAX(id) FROM agent_heartbeats WHERE agent_id = ?)
      ORDER BY received_at DESC LIMIT 1
    `).get(agentId, agentId);

    if (lastHeartbeat && lastHeartbeat.status !== status) {
      webhookService.trigger("agent.status_changed", {
        agent: { id: agentId },
        oldStatus: lastHeartbeat.status,
        newStatus: status,
      });
    }

    return { recorded: true };
  }

  // Get agent health status
  getAgentHealth(agentId) {
    const db = getDb();

    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
    if (!agent) {
      return { error: "NOT_FOUND", message: "Agent not found" };
    }

    const latestHeartbeat = db.prepare(`
      SELECT * FROM agent_heartbeats
      WHERE agent_id = ?
      ORDER BY received_at DESC LIMIT 1
    `).get(agentId);

    const heartbeatStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) as healthy,
        SUM(CASE WHEN status = 'unhealthy' THEN 1 ELSE 0 END) as unhealthy,
        MIN(received_at) as first_seen,
        MAX(received_at) as last_seen
      FROM agent_heartbeats
      WHERE agent_id = ? AND received_at > datetime('now', '-24 hours')
    `).get(agentId);

    const isOnline = latestHeartbeat &&
      new Date(latestHeartbeat.received_at) > new Date(Date.now() - 5 * 60 * 1000);

    return {
      agentId,
      online: isOnline,
      status: latestHeartbeat?.status || "unknown",
      lastHeartbeat: latestHeartbeat ? {
        status: latestHeartbeat.status,
        metrics: JSON.parse(latestHeartbeat.metrics || "{}"),
        version: latestHeartbeat.version,
        receivedAt: latestHeartbeat.received_at,
      } : null,
      stats24h: {
        totalHeartbeats: heartbeatStats.total,
        healthyCount: heartbeatStats.healthy,
        unhealthyCount: heartbeatStats.unhealthy,
        uptimePercent: heartbeatStats.total > 0
          ? Math.round((heartbeatStats.healthy / heartbeatStats.total) * 100)
          : 0,
        firstSeen: heartbeatStats.first_seen,
        lastSeen: heartbeatStats.last_seen,
      },
    };
  }

  // Get command history for agent
  getCommandHistory(agentId, { page = 1, limit = 20 } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;

    const total = db.prepare("SELECT COUNT(*) as count FROM agent_commands WHERE agent_id = ?")
      .get(agentId).count;

    const commands = db.prepare(`
      SELECT ac.*, u.username as issued_by_username
      FROM agent_commands ac
      LEFT JOIN users u ON ac.issued_by = u.id
      WHERE ac.agent_id = ?
      ORDER BY ac.issued_at DESC
      LIMIT ? OFFSET ?
    `).all(agentId, limit, offset);

    return {
      data: commands.map((c) => ({
        ...this._formatCommand(c),
        issuedByUsername: c.issued_by_username,
      })),
      pagination: { page, limit, total },
    };
  }

  // Get heartbeat history
  getHeartbeatHistory(agentId, { page = 1, limit = 50, hours = 24 } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;

    const total = db.prepare(`
      SELECT COUNT(*) as count FROM agent_heartbeats
      WHERE agent_id = ? AND received_at > datetime('now', '-${hours} hours')
    `).get(agentId).count;

    const heartbeats = db.prepare(`
      SELECT * FROM agent_heartbeats
      WHERE agent_id = ? AND received_at > datetime('now', '-${hours} hours')
      ORDER BY received_at DESC
      LIMIT ? OFFSET ?
    `).all(agentId, limit, offset);

    return {
      data: heartbeats.map((h) => ({
        id: h.id,
        status: h.status,
        metrics: JSON.parse(h.metrics || "{}"),
        ipAddress: h.ip_address,
        version: h.version,
        receivedAt: h.received_at,
      })),
      pagination: { page, limit, total },
    };
  }

  _formatCommand(row) {
    return {
      id: row.id,
      agentId: row.agent_id,
      command: row.command,
      payload: JSON.parse(row.payload || "{}"),
      status: row.status,
      result: row.result ? JSON.parse(row.result) : null,
      issuedBy: row.issued_by,
      issuedAt: row.issued_at,
      executedAt: row.executed_at,
      expiresAt: row.expires_at,
    };
  }
}

module.exports = new AgentControlService();
