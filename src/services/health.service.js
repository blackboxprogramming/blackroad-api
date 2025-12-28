const { getDb } = require("../db");
const os = require("os");

class HealthService {
  constructor() {
    this.startTime = Date.now();
    this.checks = new Map();
    this.lastCheckResults = null;
    this.checkInterval = null;
  }

  // Register a health check
  registerCheck(name, checkFn, options = {}) {
    this.checks.set(name, {
      fn: checkFn,
      critical: options.critical || false,
      timeout: options.timeout || 5000,
      interval: options.interval || 30000,
    });
  }

  // Initialize default health checks
  init() {
    // Database check
    this.registerCheck("database", () => {
      const db = getDb();
      const result = db.prepare("SELECT 1 as ok").get();
      return {
        status: result.ok === 1 ? "healthy" : "unhealthy",
        message: result.ok === 1 ? "Database connection OK" : "Database check failed",
      };
    }, { critical: true });

    // Memory check
    this.registerCheck("memory", () => {
      const used = process.memoryUsage();
      const heapUsedMB = Math.round(used.heapUsed / 1024 / 1024);
      const heapTotalMB = Math.round(used.heapTotal / 1024 / 1024);
      const usagePercent = Math.round((used.heapUsed / used.heapTotal) * 100);

      let status = "healthy";
      if (usagePercent > 90) status = "unhealthy";
      else if (usagePercent > 75) status = "degraded";

      return {
        status,
        message: `Heap: ${heapUsedMB}MB / ${heapTotalMB}MB (${usagePercent}%)`,
        metrics: {
          heapUsed: heapUsedMB,
          heapTotal: heapTotalMB,
          usagePercent,
          rss: Math.round(used.rss / 1024 / 1024),
          external: Math.round(used.external / 1024 / 1024),
        },
      };
    });

    // Disk check (data directory)
    this.registerCheck("disk", () => {
      try {
        const db = getDb();
        const pageSize = db.prepare("PRAGMA page_size").get().page_size;
        const pageCount = db.prepare("PRAGMA page_count").get().page_count;
        const dbSizeMB = Math.round((pageSize * pageCount) / 1024 / 1024);

        return {
          status: dbSizeMB < 1000 ? "healthy" : dbSizeMB < 5000 ? "degraded" : "unhealthy",
          message: `Database size: ${dbSizeMB}MB`,
          metrics: { databaseSizeMB: dbSizeMB },
        };
      } catch (err) {
        return { status: "unhealthy", message: err.message };
      }
    });

    // Active agents check
    this.registerCheck("agents", () => {
      try {
        const db = getDb();
        const total = db.prepare("SELECT COUNT(*) as count FROM agents").get().count;
        const active = db.prepare("SELECT COUNT(*) as count FROM agents WHERE active = 1").get().count;

        // Check for recent heartbeats
        let recentHeartbeats = 0;
        try {
          recentHeartbeats = db.prepare(`
            SELECT COUNT(DISTINCT agent_id) as count
            FROM agent_heartbeats
            WHERE timestamp > datetime('now', '-5 minutes')
          `).get().count;
        } catch {
          // Table might not exist
        }

        return {
          status: "healthy",
          message: `${active}/${total} agents active, ${recentHeartbeats} with recent heartbeat`,
          metrics: { total, active, recentHeartbeats },
        };
      } catch (err) {
        return { status: "degraded", message: err.message };
      }
    });

    // Start periodic checks
    this.startPeriodicChecks();
  }

  // Run all health checks
  async runChecks() {
    const results = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: Math.round((Date.now() - this.startTime) / 1000),
      checks: {},
    };

    for (const [name, check] of this.checks) {
      try {
        const startTime = Date.now();
        const result = await Promise.race([
          Promise.resolve(check.fn()),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Check timed out")), check.timeout)
          ),
        ]);

        results.checks[name] = {
          ...result,
          duration: Date.now() - startTime,
          critical: check.critical,
        };

        // Update overall status
        if (result.status === "unhealthy" && check.critical) {
          results.status = "unhealthy";
        } else if (result.status === "degraded" && results.status === "healthy") {
          results.status = "degraded";
        } else if (result.status === "unhealthy" && results.status !== "unhealthy") {
          results.status = "degraded";
        }
      } catch (err) {
        results.checks[name] = {
          status: check.critical ? "unhealthy" : "degraded",
          message: err.message,
          critical: check.critical,
        };

        if (check.critical) {
          results.status = "unhealthy";
        } else if (results.status === "healthy") {
          results.status = "degraded";
        }
      }
    }

    this.lastCheckResults = results;
    return results;
  }

  // Get last check results (without running new checks)
  getLastResults() {
    return this.lastCheckResults;
  }

  // Simple liveness check (is the service running?)
  liveness() {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  }

  // Readiness check (is the service ready to accept traffic?)
  async readiness() {
    // Check database connectivity
    try {
      const db = getDb();
      db.prepare("SELECT 1").get();
      return {
        status: "ready",
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      return {
        status: "not_ready",
        reason: err.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // Get system information
  getSystemInfo() {
    const cpus = os.cpus();
    const loadAvg = os.loadavg();

    return {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      uptime: {
        system: Math.round(os.uptime()),
        process: Math.round((Date.now() - this.startTime) / 1000),
      },
      memory: {
        total: Math.round(os.totalmem() / 1024 / 1024),
        free: Math.round(os.freemem() / 1024 / 1024),
        used: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024),
        usagePercent: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
      },
      cpu: {
        cores: cpus.length,
        model: cpus[0]?.model,
        loadAverage: {
          "1m": loadAvg[0].toFixed(2),
          "5m": loadAvg[1].toFixed(2),
          "15m": loadAvg[2].toFixed(2),
        },
      },
      process: {
        pid: process.pid,
        memory: {
          heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
          rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        },
      },
    };
  }

  // Get database stats
  getDatabaseStats() {
    const db = getDb();
    const stats = {};

    // Get table sizes
    const tables = [
      "agents",
      "users",
      "audit_log",
      "webhooks",
      "agent_commands",
      "agent_heartbeats",
      "agent_groups",
      "agent_tags",
      "scheduled_commands",
      "sessions",
      "notifications",
    ];

    for (const table of tables) {
      try {
        const count = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get().count;
        stats[table] = count;
      } catch {
        stats[table] = null;
      }
    }

    // Database file info
    try {
      const pageSize = db.prepare("PRAGMA page_size").get().page_size;
      const pageCount = db.prepare("PRAGMA page_count").get().page_count;
      const freelistCount = db.prepare("PRAGMA freelist_count").get().freelist_count;

      stats._database = {
        sizeMB: Math.round((pageSize * pageCount) / 1024 / 1024),
        pageSize,
        pageCount,
        freelistCount,
        fragmentationPercent: pageCount > 0 ? Math.round((freelistCount / pageCount) * 100) : 0,
      };
    } catch {
      stats._database = null;
    }

    return stats;
  }

  // Start periodic health checks
  startPeriodicChecks() {
    if (this.checkInterval) return;

    // Run initial check
    this.runChecks();

    // Run checks every 30 seconds
    this.checkInterval = setInterval(() => {
      this.runChecks();
    }, 30000);
  }

  // Stop periodic checks
  stopPeriodicChecks() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
}

module.exports = new HealthService();
