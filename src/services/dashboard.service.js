const { getDb } = require("../db");

class DashboardService {
  // Get overview statistics
  getOverview() {
    const db = getDb();

    const safeQuery = (query, defaultValue = 0) => {
      try {
        return db.prepare(query).get();
      } catch {
        return { count: defaultValue };
      }
    };

    // Agent stats
    const totalAgents = safeQuery("SELECT COUNT(*) as count FROM agents").count;
    const activeAgents = safeQuery("SELECT COUNT(*) as count FROM agents WHERE active = 1").count;
    const inactiveAgents = totalAgents - activeAgents;

    // User stats
    const totalUsers = safeQuery("SELECT COUNT(*) as count FROM users").count;
    const adminUsers = safeQuery("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").count;

    // Activity stats (last 24 hours)
    const auditLogs24h = safeQuery(`
      SELECT COUNT(*) as count FROM audit_log
      WHERE timestamp > datetime('now', '-24 hours')
    `).count;

    const commands24h = safeQuery(`
      SELECT COUNT(*) as count FROM agent_commands
      WHERE issued_at > datetime('now', '-24 hours')
    `).count;

    const heartbeats24h = safeQuery(`
      SELECT COUNT(*) as count FROM agent_heartbeats
      WHERE received_at > datetime('now', '-24 hours')
    `).count;

    // Webhook stats
    const totalWebhooks = safeQuery("SELECT COUNT(*) as count FROM webhooks").count;
    const activeWebhooks = safeQuery("SELECT COUNT(*) as count FROM webhooks WHERE active = 1").count;

    // Group stats
    const totalGroups = safeQuery("SELECT COUNT(*) as count FROM agent_groups").count;
    const totalTags = safeQuery("SELECT COUNT(*) as count FROM agent_tags").count;

    return {
      agents: {
        total: totalAgents,
        active: activeAgents,
        inactive: inactiveAgents,
        healthyPercent: totalAgents > 0 ? Math.round((activeAgents / totalAgents) * 100) : 0,
      },
      users: {
        total: totalUsers,
        admins: adminUsers,
        regular: totalUsers - adminUsers,
      },
      activity: {
        auditLogs24h,
        commands24h,
        heartbeats24h,
      },
      webhooks: {
        total: totalWebhooks,
        active: activeWebhooks,
      },
      organization: {
        groups: totalGroups,
        tags: totalTags,
      },
      timestamp: new Date().toISOString(),
    };
  }

  // Get agent health summary
  getAgentHealth() {
    const db = getDb();

    const agents = db.prepare(`
      SELECT a.id, a.role, a.active,
        (SELECT status FROM agent_heartbeats WHERE agent_id = a.id ORDER BY received_at DESC LIMIT 1) as last_status,
        (SELECT received_at FROM agent_heartbeats WHERE agent_id = a.id ORDER BY received_at DESC LIMIT 1) as last_heartbeat
      FROM agents a
      ORDER BY a.id
    `).all();

    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;

    return agents.map((a) => {
      const lastHeartbeat = a.last_heartbeat ? new Date(a.last_heartbeat).getTime() : 0;
      const isOnline = lastHeartbeat > now - fiveMinutes;

      return {
        id: a.id,
        role: a.role,
        active: Boolean(a.active),
        online: isOnline,
        status: a.last_status || "unknown",
        lastHeartbeat: a.last_heartbeat,
        health: isOnline && a.last_status === "healthy" ? "healthy" :
                isOnline ? "degraded" : "offline",
      };
    });
  }

  // Get activity timeline
  getActivityTimeline({ hours = 24, interval = "hour" } = {}) {
    const db = getDb();

    const format = interval === "hour" ? "%Y-%m-%d %H:00" : "%Y-%m-%d";
    const timeFilter = `-${hours} hours`;

    // Audit log activity
    const auditActivity = db.prepare(`
      SELECT strftime('${format}', timestamp) as period, COUNT(*) as count
      FROM audit_log
      WHERE timestamp > datetime('now', '${timeFilter}')
      GROUP BY period
      ORDER BY period
    `).all();

    // Command activity
    const commandActivity = db.prepare(`
      SELECT strftime('${format}', issued_at) as period, COUNT(*) as count
      FROM agent_commands
      WHERE issued_at > datetime('now', '${timeFilter}')
      GROUP BY period
      ORDER BY period
    `).all();

    // Heartbeat activity
    const heartbeatActivity = db.prepare(`
      SELECT strftime('${format}', received_at) as period, COUNT(*) as count
      FROM agent_heartbeats
      WHERE received_at > datetime('now', '${timeFilter}')
      GROUP BY period
      ORDER BY period
    `).all();

    // Merge into timeline
    const timeline = {};

    for (const item of auditActivity) {
      if (!timeline[item.period]) timeline[item.period] = { period: item.period };
      timeline[item.period].auditLogs = item.count;
    }

    for (const item of commandActivity) {
      if (!timeline[item.period]) timeline[item.period] = { period: item.period };
      timeline[item.period].commands = item.count;
    }

    for (const item of heartbeatActivity) {
      if (!timeline[item.period]) timeline[item.period] = { period: item.period };
      timeline[item.period].heartbeats = item.count;
    }

    return Object.values(timeline).sort((a, b) => a.period.localeCompare(b.period));
  }

  // Get top actions/events
  getTopActions({ limit = 10, hours = 24 } = {}) {
    const db = getDb();

    const topActions = db.prepare(`
      SELECT action, COUNT(*) as count
      FROM audit_log
      WHERE timestamp > datetime('now', '-${hours} hours')
      GROUP BY action
      ORDER BY count DESC
      LIMIT ?
    `).all(limit);

    const topResources = db.prepare(`
      SELECT resource_type, COUNT(*) as count
      FROM audit_log
      WHERE timestamp > datetime('now', '-${hours} hours')
      GROUP BY resource_type
      ORDER BY count DESC
      LIMIT ?
    `).all(limit);

    const topCommands = db.prepare(`
      SELECT command, COUNT(*) as count
      FROM agent_commands
      WHERE issued_at > datetime('now', '-${hours} hours')
      GROUP BY command
      ORDER BY count DESC
      LIMIT ?
    `).all(limit);

    return {
      actions: topActions,
      resources: topResources,
      commands: topCommands,
    };
  }

  // Get agent role distribution
  getAgentsByRole() {
    const db = getDb();

    return db.prepare(`
      SELECT role,
        COUNT(*) as total,
        SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) as active
      FROM agents
      GROUP BY role
      ORDER BY total DESC
    `).all();
  }

  // Get recent activity feed
  getRecentActivity({ limit = 50 } = {}) {
    const db = getDb();

    const auditLogs = db.prepare(`
      SELECT
        'audit' as type,
        al.id,
        al.action,
        al.resource_type,
        al.resource_id,
        u.username,
        al.timestamp as created_at
      FROM audit_log al
      LEFT JOIN users u ON al.user_id = u.id
      ORDER BY al.timestamp DESC
      LIMIT ?
    `).all(limit);

    const commands = db.prepare(`
      SELECT
        'command' as type,
        ac.id,
        ac.command as action,
        'agent' as resource_type,
        ac.agent_id as resource_id,
        u.username,
        ac.issued_at as created_at
      FROM agent_commands ac
      LEFT JOIN users u ON ac.issued_by = u.id
      ORDER BY ac.issued_at DESC
      LIMIT ?
    `).all(limit);

    // Merge and sort
    const activity = [...auditLogs, ...commands]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit);

    return activity;
  }

  // Get system health metrics
  getSystemMetrics() {
    const uptime = process.uptime();
    const memory = process.memoryUsage();

    return {
      uptime: {
        seconds: Math.floor(uptime),
        formatted: this._formatUptime(uptime),
      },
      memory: {
        rss: memory.rss,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
        external: memory.external,
        formatted: {
          rss: this._formatBytes(memory.rss),
          heapTotal: this._formatBytes(memory.heapTotal),
          heapUsed: this._formatBytes(memory.heapUsed),
        },
      },
      node: {
        version: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      timestamp: new Date().toISOString(),
    };
  }

  _formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);

    return parts.join(" ") || "< 1m";
  }

  _formatBytes(bytes) {
    const units = ["B", "KB", "MB", "GB"];
    let unitIndex = 0;
    let size = bytes;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }
}

module.exports = new DashboardService();
